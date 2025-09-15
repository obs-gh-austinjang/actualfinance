import express from 'express';

// OpenTelemetry imports
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { logger, tracer, secretOperationsTotal } from './otel.js';

import { getAccountDb, isAdmin } from './account-db.js';
import { secretsService } from './services/secrets-service.js';
import {
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares.js';

const app = express();

export { app as handlers };
app.use(express.json());
app.use(requestLoggerMiddleware);
app.use(validateSessionMiddleware);

app.post('/', async (req, res) => {
  const span = tracer.startSpan('secrets.set');

  try {
    let method;
    try {
      const result = getAccountDb().first(
        'SELECT method FROM auth WHERE active = 1',
      );
      method = result?.method;
    } catch (error) {
      console.error('Failed to fetch auth method:', error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'Database error fetching auth method' });
      span.end();
      return res.status(500).send({
        status: 'error',
        reason: 'database-error',
        details: 'Failed to validate authentication method',
      });
    }

    const { name, value } = req.body || {};

    span.setAttributes({
      'secrets.name': name || 'unknown',
      'secrets.auth_method': method || 'unknown',
      'secrets.has_value': !!value,
      'secrets.user_id': res.locals.user_id || 'unknown',
    });

    if (method === 'openid') {
      const canSaveSecrets = isAdmin(res.locals.user_id);

      if (!canSaveSecrets) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'Not admin' });
        span.end();
        res.status(403).send({
          status: 'error',
          reason: 'not-admin',
          details: 'You have to be admin to set secrets',
        });

        return;
      }
    }

    secretsService.set(name, value);

    // Record metrics
    secretOperationsTotal.add(1, {
      operation: 'set',
      status: 'success',
      auth_method: method || 'unknown',
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
    res.status(200).send({ status: 'ok' });
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error setting secret',
      attributes: { error: error.message, secret_name: name || 'unknown' },
    });

    // Record metrics
    secretOperationsTotal.add(1, {
      operation: 'set',
      status: 'error',
      auth_method: 'unknown',
    });

    res.status(500).send({ status: 'error', reason: 'internal-error' });
  }
});

app.get('/:name', async (req, res) => {
  const span = tracer.startSpan('secrets.get');

  try {
    const name = req.params.name;
    const keyExists = secretsService.exists(name);

    span.setAttributes({
      'secrets.name': name,
      'secrets.exists': keyExists,
    });

    // Record metrics
    secretOperationsTotal.add(1, {
      operation: 'get',
      status: 'success',
      exists: keyExists.toString(),
    });

    if (keyExists) {
      res.sendStatus(204);
    } else {
      res.status(404).send('key not found');
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();

    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error getting secret',
      attributes: { error: error.message, secret_name: req.params.name || 'unknown' },
    });

    // Record metrics
    secretOperationsTotal.add(1, {
      operation: 'get',
      status: 'error',
      exists: 'unknown',
    });

    res.status(500).send({ status: 'error', reason: 'internal-error' });
  }
});
