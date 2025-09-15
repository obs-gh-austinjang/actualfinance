import express from 'express';

// OpenTelemetry imports
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { logger, tracer, authOperationsTotal } from './otel.js';

import {
  bootstrap,
  needsBootstrap,
  getLoginMethod,
  listLoginMethods,
  getUserInfo,
  getActiveLoginMethod,
} from './account-db.js';
import { isValidRedirectUrl, loginWithOpenIdSetup } from './accounts/openid.js';
import { changePassword, loginWithPassword } from './accounts/password.js';
import {
  errorMiddleware,
  requestLoggerMiddleware,
} from './util/middlewares.js';
import { validateAuthHeader, validateSession } from './util/validate-user.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(errorMiddleware);
app.use(requestLoggerMiddleware);
export { app as handlers };

// Non-authenticated endpoints:
//
// /needs-bootstrap
// /boostrap (special endpoint for setting up the instance, cant call again)
// /login

app.get('/needs-bootstrap', (req, res) => {
  const span = tracer.startSpan('account.needs_bootstrap');

  try {
    const availableLoginMethods = listLoginMethods();
    const bootstrapped = !needsBootstrap();

    span.setAttributes({
      'account.bootstrapped': bootstrapped,
      'account.available_login_methods_count': availableLoginMethods.length,
      'account.multiuser': getActiveLoginMethod() === 'openid',
    });

    // Record metrics
    authOperationsTotal.add(1, {
      operation: 'needs_bootstrap',
      status: 'success',
      bootstrapped: bootstrapped.toString(),
    });

    res.send({
      status: 'ok',
      data: {
        bootstrapped,
        loginMethod:
          availableLoginMethods.length === 1
            ? availableLoginMethods[0].method
            : getLoginMethod(),
        availableLoginMethods,
        multiuser: getActiveLoginMethod() === 'openid',
      },
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error checking bootstrap status',
      attributes: { error: error.message },
    });

    throw error;
  }
});

app.post('/bootstrap', async (req, res) => {
  const span = tracer.startSpan('account.bootstrap');

  try {
    span.setAttributes({
      'account.bootstrap.has_password': !!req.body.password,
      'account.bootstrap.has_openid': !!req.body.openId,
    });

    const boot = await bootstrap(req.body);

    if (boot?.error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: boot.error });
      span.end();
      res.status(400).send({ status: 'error', reason: boot?.error });
      return;
    }

    span.setAttributes({
      'account.bootstrap.success': true,
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    res.send({ status: 'ok', data: boot });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error during bootstrap',
      attributes: { error: error.message },
    });

    throw error;
  }
});

app.get('/login-methods', (req, res) => {
  const methods = listLoginMethods();
  res.send({ status: 'ok', methods });
});

app.post('/login', async (req, res) => {
  const span = tracer.startSpan('account.login');

  try {
    const loginMethod = getLoginMethod(req);
    console.log('Logging in via ' + loginMethod);

    span.setAttributes({
      'account.login.method': loginMethod,
    });

    let tokenRes = null;
    switch (loginMethod) {
      case 'header': {
        const headerVal = req.get('x-actual-password') || '';
        const obfuscated =
          '*'.repeat(headerVal.length) || 'No password provided.';
        console.debug('HEADER VALUE: ' + obfuscated);
        if (headerVal === '') {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid header' });
          span.end();
          res.send({ status: 'error', reason: 'invalid-header' });
          return;
        } else {
          if (validateAuthHeader(req)) {
            tokenRes = loginWithPassword(headerVal);
          } else {
            span.setStatus({ code: SpanStatusCode.ERROR, message: 'Proxy not trusted' });
            span.end();
            res.send({ status: 'error', reason: 'proxy-not-trusted' });
            return;
          }
        }
        break;
      }
      case 'openid': {
        if (!isValidRedirectUrl(req.body.returnUrl)) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: 'Invalid redirect URL' });
          span.end();
          res
            .status(400)
            .send({ status: 'error', reason: 'Invalid redirect URL' });
          return;
        }

        const { error, url } = await loginWithOpenIdSetup(
          req.body.returnUrl,
          req.body.password,
        );
        if (error) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: error });
          span.end();
          res.status(400).send({ status: 'error', reason: error });
          return;
        }

        span.setAttributes({
          'account.login.openid_success': true,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
        res.send({ status: 'ok', data: { returnUrl: url } });
        return;
      }

      default:
        tokenRes = loginWithPassword(req.body.password);
        break;
    }
    const { error, token } = tokenRes;

    if (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: error });
      span.end();

      // Record metrics
      authOperationsTotal.add(1, {
        operation: 'login',
        method: loginMethod,
        status: 'error',
      });

      res.status(400).send({ status: 'error', reason: error });
      return;
    }

    span.setAttributes({
      'account.login.success': true,
    });

    // Record metrics
    authOperationsTotal.add(1, {
      operation: 'login',
      method: loginMethod,
      status: 'success',
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    res.send({ status: 'ok', data: { token } });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error during login',
      attributes: { error: error.message },
    });

    // Record metrics
    authOperationsTotal.add(1, {
      operation: 'login',
      method: 'unknown',
      status: 'error',
    });

    res.status(500).send({ status: 'error', reason: 'internal-error' });
  }
});

app.post('/change-password', (req, res) => {
  const session = validateSession(req, res);
  if (!session) return;

  const { error } = changePassword(req.body.password);

  if (error) {
    res.status(400).send({ status: 'error', reason: error });
    return;
  }

  res.send({ status: 'ok', data: {} });
});

app.get('/validate', (req, res) => {
  const session = validateSession(req, res);
  if (session) {
    const user = getUserInfo(session.user_id);
    if (!user) {
      res.status(400).send({ status: 'error', reason: 'User not found' });
      return;
    }

    res.send({
      status: 'ok',
      data: {
        validated: true,
        userName: user?.user_name,
        permission: user?.role,
        userId: session?.user_id,
        displayName: user?.display_name,
        loginMethod: session?.auth_method,
      },
    });
  }
});
