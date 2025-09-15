import fs, { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// OpenTelemetry imports
import { SpanStatusCode } from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { bootstrap } from './account-db.js';
import * as accountApp from './app-account.js';
import * as adminApp from './app-admin.js';
import * as goCardlessApp from './app-gocardless/app-gocardless.js';
import * as openidApp from './app-openid.js';
import * as pluggai from './app-pluggyai/app-pluggyai.js';
import * as secretApp from './app-secrets.js';
import * as simpleFinApp from './app-simplefin/app-simplefin.js';
import * as syncApp from './app-sync.js';
import { config } from './load-config.js';
import { logger, tracer, meter } from './otel.js';

const app = express();

// Initialize metrics
const httpRequestsTotal = meter.createCounter('http_requests_total', {
  description: 'Total number of HTTP requests',
});

const httpRequestDuration = meter.createHistogram(
  'http_request_duration_seconds',
  {
    description: 'Duration of HTTP requests in seconds',
  },
);

const serverStartTime = meter.createGauge('server_start_time_seconds', {
  description: 'Unix timestamp when the server started',
});

// Metrics are defined in otel.ts and imported where needed

// Record server start time
serverStartTime.record(Date.now() / 1000);

process.on('unhandledRejection', reason => {
  console.log('Rejection:', reason);
  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: 'ERROR',
    body: 'Unhandled promise rejection',
    attributes: { reason: String(reason) },
  });
});

app.disable('x-powered-by');
app.use(cors());
app.set('trust proxy', config.get('trustedProxies'));
if (process.env.NODE_ENV !== 'development') {
  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 500,
      legacyHeaders: false,
      standardHeaders: true,
    }),
  );
}

// Add request tracking middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const statusCode = res.statusCode.toString();

    // Record metrics
    httpRequestsTotal.add(1, {
      method: req.method,
      route: req.route?.path || req.path,
      status_code: statusCode,
    });

    httpRequestDuration.record(duration, {
      method: req.method,
      route: req.route?.path || req.path,
      status_code: statusCode,
    });

    // Log request
    logger.emit({
      severityNumber:
        res.statusCode >= 400 ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: res.statusCode >= 400 ? 'WARN' : 'INFO',
      body: `${req.method} ${req.path} ${res.statusCode}`,
      attributes: {
        method: req.method,
        path: req.path,
        status_code: res.statusCode,
        duration_ms: Date.now() - startTime,
        user_agent: req.get('User-Agent') || '',
      },
    });
  });

  next();
});

app.use(express.json({ limit: `${config.get('upload.fileSizeLimitMB')}mb` }));

app.use(
  express.raw({
    type: 'application/actual-sync',
    limit: `${config.get('upload.fileSizeSyncLimitMB')}mb`,
  }),
);

app.use(
  express.raw({
    type: 'application/encrypted-file',
    limit: `${config.get('upload.syncEncryptedFileSizeLimitMB')}mb`,
  }),
);

app.use('/sync', syncApp.handlers);
app.use('/account', accountApp.handlers);
app.use('/gocardless', goCardlessApp.handlers);
app.use('/simplefin', simpleFinApp.handlers);
app.use('/pluggyai', pluggai.handlers);
app.use('/secret', secretApp.handlers);

app.use('/admin', adminApp.handlers);
app.use('/openid', openidApp.handlers);

app.get('/mode', (req, res) => {
  res.send(config.get('mode'));
});

app.get('/info', (_req, res) => {
  function findPackageJson(startDir: string) {
    // find the nearest package.json file while traversing up the directory tree
    let currentPath = startDir;
    let directoriesSearched = 0;
    const pathRoot = resolve(currentPath, '/');
    try {
      while (currentPath !== pathRoot && directoriesSearched < 5) {
        const packageJsonPath = resolve(currentPath, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(
            readFileSync(packageJsonPath, 'utf-8'),
          );

          if (packageJson.name === '@actual-app/sync-server') {
            return packageJson;
          }
        }

        currentPath = resolve(join(currentPath, '..')); // Move up one directory
        directoriesSearched++;
      }
    } catch (error) {
      console.error('Error while searching for package.json:', error);
    }

    return null;
  }

  const dirname = resolve(fileURLToPath(import.meta.url), '../');
  const packageJson = findPackageJson(dirname);

  res.status(200).json({
    build: {
      name: packageJson?.name,
      description: packageJson?.description,
      version: packageJson?.version,
    },
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'UP' });
});

app.get('/metrics', (_req, res) => {
  const memUsage = process.memoryUsage();
  const uptime = process.uptime();

  res.status(200).json({
    // System metrics
    memory: {
      rss: memUsage.rss,
      heapTotal: memUsage.heapTotal,
      heapUsed: memUsage.heapUsed,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers,
    },
    uptime,

    // Process metrics
    process: {
      pid: process.pid,
      version: process.version,
      platform: process.platform,
      arch: process.arch,
    },

    // OpenTelemetry info
    telemetry: {
      service_name: 'actual-sync-server',
      service_version: process.env.npm_package_version || '25.9.0',
      instrumentation: 'opentelemetry',
    },

    // Timestamp
    timestamp: new Date().toISOString(),
  });
});

// The web frontend
app.use((req, res, next) => {
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});
if (process.env.NODE_ENV === 'development') {
  console.log(
    'Running in development mode - Proxying frontend routes to React Dev Server',
  );

  // Imported within Dev block to allow dev dependency in package.json (reduces package size in production)
  const httpProxyMiddleware = await import('http-proxy-middleware');

  app.use(
    httpProxyMiddleware.createProxyMiddleware({
      target: 'http://localhost:3001',
      changeOrigin: true,
      ws: true,
    }),
  );
} else {
  console.log('Running in production mode - Serving static React app');

  app.use(express.static(config.get('webRoot'), { index: false }));
  app.get('/{*splat}', (req, res) =>
    res.sendFile('index.html', { root: config.get('webRoot') }),
  );
}

function parseHTTPSConfig(value: string) {
  if (value.startsWith('-----BEGIN')) {
    return value;
  }
  return fs.readFileSync(value);
}

function sendServerStartedMessage() {
  // Signify to any parent process that the server has started. Used in electron desktop app
  // @ts-ignore-error electron types
  process.parentPort?.postMessage({ type: 'server-started' });
  console.log(
    'Listening on ' + config.get('hostname') + ':' + config.get('port') + '...',
  );
}

export async function run() {
  const span = tracer.startSpan('server.start');

  try {
    const portVal = config.get('port');
    const port = typeof portVal === 'string' ? parseInt(portVal) : portVal;
    const hostname = config.get('hostname');

    span.setAttributes({
      'server.port': port,
      'server.hostname': hostname,
    });
    const openIdConfig = config?.getProperties()?.openId;
    if (
      openIdConfig?.discoveryURL ||
      // @ts-expect-error FIXME no types for config yet
      openIdConfig?.issuer?.authorization_endpoint
    ) {
      console.log('OpenID configuration found. Preparing server to use it');
      try {
        const { error } = await bootstrap({ openId: openIdConfig }, true);
        if (error) {
          console.log(error);
        } else {
          console.log('OpenID configured!');
        }
      } catch (err) {
        console.error(err);
      }
    }

    if (config.get('https.key') && config.get('https.cert')) {
      const https = await import('node:https');
      const httpsOptions = {
        ...config.get('https'),
        key: parseHTTPSConfig(config.get('https.key')),
        cert: parseHTTPSConfig(config.get('https.cert')),
      };
      https.createServer(httpsOptions, app).listen(port, hostname, () => {
        sendServerStartedMessage();
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      });
    } else {
      app.listen(port, hostname, () => {
        sendServerStartedMessage();
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      });
    }
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: (error as Error).message,
    });
    span.end();
    logger.emit({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      body: 'Error starting server',
      attributes: { error: (error as Error).message },
    });
    throw error;
  }
}
