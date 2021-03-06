import path from 'path'
import expressLogger from 'express-pino-logger'
import WebSocket from 'ws'
import http from 'http'
import https from 'https'

import bodyParser from 'body-parser'
import cookieParser from 'cookie-parser'
import logger from './logger'
import setup from './setup'
import admin from './admin'
import userController from './user'
import db from './db'
import appController from './app'
import connections from './ws'
import statusCodes from './statusCodes'
import responseBuilder from './responseBuilder'
import { trimReq } from './utils'

const adminPanelDir = '/admin-panel/dist'

const ONE_KB = 1024

// DynamoDB single item limit: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Limits.html#limits-items
const FOUR_HUNDRED_KB = 400 * ONE_KB

const FIVE_KB = 5 * ONE_KB

const HSTS_MAX_AGE = 63072000 // 2 years

if (process.env.NODE_ENV == 'development') {
  logger.warn('Development Mode')
}

async function start(express, app, userbaseConfig = {}) {
  try {
    const {
      httpsKey,
      httpsCert,
      stripeRedirectUrl
    } = userbaseConfig

    if (stripeRedirectUrl) process.env['STRIPE_REDIRECT_URL'] = stripeRedirectUrl

    await setup.init(userbaseConfig)

    const certExists = httpsKey && httpsCert
    const httpPort = userbaseConfig.httpPort || 8080
    const httpsPort = userbaseConfig.httpsPort || 8443

    const server = certExists ?
      https.createServer({ key: httpsKey, cert: httpsCert }, app)
        .listen(httpsPort, () => logger.info(`App listening on https port ${httpsPort}....`)) :
      http.createServer(app)
        .listen(httpPort, () => logger.info(`App listening on http port ${httpPort}....`))

    const wss = new WebSocket.Server({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const res = new http.ServerResponse(req)
      res.assignSocket(socket)
      res.on('finish', () => res.socket.destroy())
      req.ws = true
      res.ws = fn => wss.handleUpgrade(req, socket, head, fn)
      app(req, res)
    })

    const heartbeat = function (ws) {
      ws.isAlive = true
    }

    wss.on('connection', (ws, req, res) => {
      ws.isAlive = true
      const userId = res.locals.user['user-id']
      const userPublicKey = res.locals.user['public-key']
      const adminId = res.locals.admin['admin-id']
      const appId = res.locals.app['app-id']

      const clientId = req.query.clientId

      const conn = connections.register(userId, ws, clientId, adminId, appId)
      if (conn) {
        const connectionId = conn.id

        const { validationMessage, encryptedValidationMessage } = userController.getValidationMessage(userPublicKey)

        logger.child({ userId, connectionId, adminId, appId, route: 'Connection' }).info('Sending Connection over WebSocket')
        ws.send(JSON.stringify({
          route: 'Connection',
          keySalts: {
            encryptionKeySalt: res.locals.user['encryption-key-salt'],
            dhKeySalt: res.locals.user['diffie-hellman-key-salt'],
            hmacKeySalt: res.locals.user['hmac-key-salt'],
          },
          encryptedValidationMessage
        }))

        ws.on('close', () => connections.close(conn))

        ws.on('message', async (msg) => {
          ws.isAlive = true

          const start = Date.now()
          let logChildObject

          try {
            logChildObject = { userId, connectionId, adminId, clientId, appId, size: msg.length || msg.byteLength }

            if (msg.length > FOUR_HUNDRED_KB || msg.byteLength > FOUR_HUNDRED_KB) {
              logger.child(logChildObject).warn('Received large message')
              return ws.send('Message is too large')
            }

            const request = JSON.parse(msg)

            const requestId = request.requestId
            const action = request.action
            const params = request.params

            let response

            if (action === 'Pong') {
              heartbeat(ws)
              return
            }

            logChildObject.requestId = requestId
            logChildObject.action = action
            logger.child(logChildObject).info('Received WebSocket request')

            if (conn.rateLimiter.atCapacity()) {

              response = responseBuilder.errorResponse(statusCodes['Too Many Requests'], { retryDelay: 1000 })

            } else {

              if (action === 'SignOut') {
                response = await userController.signOut(params.sessionId)
              } else if (!conn.keyValidated) {

                switch (action) {
                  case 'ValidateKey': {
                    response = await userController.validateKey(
                      validationMessage,
                      params.validationMessage,
                      res.locals.user,
                      conn
                    )
                    break
                  }
                  default: {
                    response = responseBuilder.errorResponse(statusCodes['Unauthorized'], 'Key not validated')
                  }
                }

              } else {

                switch (action) {
                  case 'ValidateKey': {
                    response = responseBuilder.errorResponse(statusCodes['Bad Request'], 'Already validated key')
                    break
                  }
                  case 'UpdateUser': {
                    response = await userController.updateUser(
                      userId,
                      params.username,
                      params.currentPasswordToken,
                      params.passwordToken,
                      params.passwordSalts,
                      params.email,
                      params.profile,
                      params.passwordBasedBackup
                    )
                    break
                  }
                  case 'DeleteUser': {
                    response = await userController.deleteUserController(
                      userId,
                      adminId,
                      res.locals.app['app-name']
                    )
                    break
                  }
                  case 'OpenDatabase': {
                    response = await db.openDatabase(
                      userId,
                      connectionId,
                      params.dbNameHash,
                      params.newDatabaseParams,
                      params.reopenAtSeqNo
                    )
                    break
                  }
                  case 'Insert':
                  case 'Update':
                  case 'Delete': {
                    response = await db.doCommand(
                      action,
                      userId,
                      connectionId,
                      params.dbNameHash,
                      params.dbId,
                      params.itemKey,
                      params.encryptedItem
                    )
                    break
                  }
                  case 'BatchTransaction': {
                    response = await db.batchTransaction(userId, connectionId, params.dbNameHash, params.dbId, params.operations)
                    break
                  }
                  case 'Bundle': {
                    response = await db.bundleTransactionLog(userId, connectionId, params.dbId, params.seqNo, params.bundle)
                    break
                  }
                  case 'GetPasswordSalts': {
                    response = await userController.getPasswordSaltsByUserId(userId)
                    break
                  }
                  default: {
                    logger
                      .child(logChildObject)
                      .error('Received unknown action over WebSocket')
                    return ws.send(`Received unkown action ${action}`)
                  }
                }
              }
            }

            const responseMsg = JSON.stringify({
              requestId,
              response,
              route: action
            })

            logger
              .child({
                ...logChildObject,
                statusCode: response.status,
                size: responseMsg.length,
                responseTime: Date.now() - start,
              })
              .info('Sent response over WebSocket')

            ws.send(responseMsg)

          } catch (e) {
            logger
              .child({ ...logChildObject, err: e, msg })
              .error('Error in Websocket handling message')
          }

        })
      }
    })

    // client first must prove it has access to the user's key by decrypting encryptedFrgotPasswordToken,
    // then can proceed to request email with temp password be sent to user
    wss.on('forgot-password', async (ws, req) => {
      ws.isAlive = true // only gets set once. websocket will terminate automatically in 30-60s
      const start = Date.now()

      const appId = req.query.appId
      const username = req.query.username

      logger.child({ appId, username, req: trimReq(req) }).info('Opened forgot-password WebSocket')

      const forgotPasswordTokenResult = await userController.generateForgotPasswordToken(req, appId, username)

      if (forgotPasswordTokenResult.status !== statusCodes['Success']) {

        ws.send(JSON.stringify({
          route: 'Error',
          status: forgotPasswordTokenResult.status,
          data: forgotPasswordTokenResult.data
        }))
        ws.terminate()

      } else {

        const {
          user,
          app,
          admin,
          forgotPasswordToken,
          encryptedForgotPasswordToken
        } = forgotPasswordTokenResult.data

        const userId = user['user-id']
        const adminId = admin['admin-id']

        ws.send(JSON.stringify({
          route: 'ReceiveEncryptedToken',
          dhKeySalt: user['diffie-hellman-key-salt'],
          encryptedForgotPasswordToken
        }))

        ws.on('message', async (msg) => {
          try {
            if (msg.length > FIVE_KB || msg.byteLength > FIVE_KB) {
              logger.child({ userId, appId, adminId, size: msg.length, req: trimReq(req) }).warn('Received large message over forgot-password')
              return ws.send('Message is too large')
            }

            const request = JSON.parse(msg)
            const { action, params } = request

            if (action === 'ForgotPassword') {
              const forgotPasswordResponse = await userController.forgotPassword(req, forgotPasswordToken, params.forgotPasswordToken, user, app)

              if (forgotPasswordResponse.status !== statusCodes['Success']) {

                ws.send(JSON.stringify({
                  route: 'Error',
                  status: forgotPasswordResponse.status,
                  data: forgotPasswordResponse.data
                }))
                ws.terminate()

              } else {
                const responseMsg = JSON.stringify({ route: 'SuccessfullyForgotPassword', response: forgotPasswordResponse })

                logger
                  .child({
                    userId,
                    appId,
                    adminId,
                    route: action,
                    statusCode: forgotPasswordResponse.status,
                    size: responseMsg.length,
                    req: trimReq(req),
                    responseTime: Date.now() - start
                  })
                  .info('Forgot password finished')

                ws.send(responseMsg)
                ws.terminate()
              }
            } else {
              throw new Error('Received unknown message')
            }

          } catch (e) {
            logger.child({ userId, appId, adminId, err: e, msg, req: trimReq(req) }).error('Error in forgot-password Websocket')
          }
        })
      }
    })

    setInterval(function ping() {
      wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate()

        ws.isAlive = false
        ws.send(JSON.stringify({ route: 'Ping' }))
      })
    }, 30000)

    // browsers will cache setting to use https for all future requests to server
    app.use(function (req, res, next) {
      res.setHeader('Strict-Transport-Security', `max-age: ${HSTS_MAX_AGE}; includeSubDomains; preload`)
      next()
    })

    app.use(expressLogger({ logger }))
    app.get('/ping', function (req, res) {
      res.send('Healthy')
    })

    // Userbase user API
    const v1Api = express.Router()
    app.use('/v1/api', v1Api)

    v1Api.use(bodyParser.json())

    v1Api.get('/', userController.authenticateUser, (req, res) =>
      req.ws
        ? res.ws(socket => wss.emit('connection', socket, req, res))
        : res.send('Not a websocket!')
    )
    v1Api.post('/auth/sign-up', userController.signUp)
    v1Api.post('/auth/sign-in', userController.signIn)
    v1Api.post('/auth/sign-in-with-session', userController.authenticateUser, userController.extendSession)
    v1Api.get('/auth/server-public-key', userController.getServerPublicKey)
    v1Api.get('/auth/get-password-salts', userController.getPasswordSaltsController)
    v1Api.get('/auth/forgot-password', (req, res) =>
      req.ws
        ? res.ws(socket => wss.emit('forgot-password', socket, req, res))
        : res.send('Not a websocket!')
    )

    // Userbase admin API
    app.use(express.static(path.join(__dirname + adminPanelDir)))
    const v1Admin = express.Router()
    app.use('/v1/admin', v1Admin)

    v1Admin.use(cookieParser())

    v1Admin.post('/stripe/webhook', bodyParser.raw({ type: 'application/json' }), admin.handleStripeWebhook)

    // must come after stripe/webhook to ensure parsing done correctly
    v1Admin.use(bodyParser.json())

    v1Admin.post('/create-admin', admin.createAdminController)
    v1Admin.post('/sign-in', admin.signInAdmin)
    v1Admin.post('/sign-out', admin.authenticateAdmin, admin.signOutAdmin)
    v1Admin.post('/create-app', admin.authenticateAdmin, admin.getSaasSubscriptionController, appController.createAppController)
    v1Admin.post('/list-apps', admin.authenticateAdmin, appController.listApps)
    v1Admin.post('/list-app-users', admin.authenticateAdmin, appController.listAppUsers)
    v1Admin.post('/delete-app', admin.authenticateAdmin, admin.getSaasSubscriptionController, appController.deleteApp)
    v1Admin.post('/permanent-delete-app', admin.authenticateAdmin, admin.getSaasSubscriptionController, appController.permanentDeleteAppController)
    v1Admin.post('/delete-user', admin.authenticateAdmin, admin.deleteUser)
    v1Admin.post('/permanent-delete-user', admin.authenticateAdmin, admin.permanentDeleteUser)
    v1Admin.post('/delete-admin', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.deleteAdmin)
    v1Admin.post('/update-admin', admin.authenticateAdmin, admin.updateAdmin)
    v1Admin.post('/change-password', admin.authenticateAdmin, admin.changePassword)
    v1Admin.post('/forgot-password', admin.forgotPassword)
    v1Admin.get('/access-tokens', admin.authenticateAdmin, admin.getAccessTokens)
    v1Admin.post('/access-token', admin.authenticateAdmin, admin.generateAccessToken)
    v1Admin.delete('/access-token', admin.authenticateAdmin, admin.deleteAccessToken)
    v1Admin.get('/account', admin.authenticateAdmin, admin.getSaasSubscriptionController, (req, res) => {
      const admin = res.locals.admin
      const subscription = res.locals.subscription

      const result = {
        email: admin['email'],
        fullName: admin['full-name']
      }

      if (subscription) result.paymentStatus = subscription.cancel_at_period_end ? 'cancel_at_period_end' : subscription.status

      return res.send(result)
    })

    v1Admin.post('/stripe/create-saas-payment-session', admin.authenticateAdmin, admin.createSaasPaymentSession)
    v1Admin.post('/stripe/update-saas-payment-session', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.updateSaasSubscriptionPaymentSession)
    v1Admin.post('/stripe/cancel-saas-subscription', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.cancelSaasSubscription)
    v1Admin.post('/stripe/resume-saas-subscription', admin.authenticateAdmin, admin.getSaasSubscriptionController, admin.resumeSaasSubscription)

    // Access token endpoints
    v1Admin.post('/users/:userId', admin.authenticateAccessToken, userController.updateProtectedProfile)
    v1Admin.get('/users/:userId', admin.authenticateAccessToken, userController.adminGetUserController)
    v1Admin.get('/apps/:appId', admin.authenticateAccessToken, appController.getAppController)
    v1Admin.get('/apps/:appId/users', admin.authenticateAccessToken, appController.listUsersWithPagination)
    v1Admin.get('/apps', admin.authenticateAccessToken, appController.listAppsWithPagination)
    v1Admin.get('/auth-tokens/:authToken', admin.authenticateAccessToken, userController.verifyAuthToken)

    // internal server used to receive notifications of transactions from peers -- shouldn't be exposed to public
    const internalServer = express()
    const internalServerPort = 9000
    http.createServer(internalServer)
      .listen(internalServerPort, () => logger.info(`Internal server listening on http port ${internalServerPort}....`))

    internalServer.use(bodyParser.json())
    internalServer.post('/internal/notify-transaction', (req, res) => {
      const transaction = req.body.transaction
      const userId = req.body.userId

      let logChildObject
      try {
        logChildObject = { userId, databaseId: transaction['database-id'], seqNo: transaction['seq-no'], req: trimReq(req) }
        logger
          .child(logChildObject)
          .info('Received internal notification to update db')

        connections.push(transaction, userId)
      } catch (e) {
        const msg = 'Error pushing internal transaction to connected clients'
        logger.child({ ...logChildObject, err: e }).error(msg)
        return res.status(statusCodes['Internal Server Error']).send(msg)
      }

      return res.end()
    })

  } catch (e) {
    logger.info(`Unhandled error while launching server: ${e}`)
  }
}

function createAdmin({ email, password, fullName, adminId, receiveEmailUpdates, storePasswordInSecretsManager = false }) {
  return admin.createAdmin(email, password, fullName, adminId, receiveEmailUpdates, storePasswordInSecretsManager)
}

function createApp({ appName, adminId, appId }) {
  return appController.createApp(appName, adminId, appId)
}

export default {
  start,
  createAdmin,
  createApp
}
