# Vercel -> Grafana Loki Log Drain Adapter

Minimal Next.js (App Router) endpoint that receives Vercel Log Drain NDJSON over HTTP POST and forwards it to Grafana Cloud Loki.

## Endpoint

`POST /api/vercel-log-drain`

Auth header:

- `x-drain-token` (must match `VERCEL_DRAIN_TOKEN`)

Drain setup verification:

- This route automatically handles Vercel's `x-vercel-verify` header so the drain can be created/verified from the dashboard.

## Environment variables

Set these in `.env` (or in your hosting provider):

- `VERCEL_DRAIN_TOKEN` - token checked against the `x-drain-token` request header
- `GRAFANA_LOKI_PUSH_URL` - Grafana Cloud Loki push URL (e.g. `https://logs-prod-<region>.grafana.net/loki/api/v1/push`)
- `GRAFANA_LOKI_USER` - Grafana Cloud Loki username/tenant id used for Basic Auth
- `GRAFANA_CLOUD_TOKEN` - Grafana Cloud access policy token used for Basic Auth

## Configure the Vercel Log Drain

1. Create a Log Drain in the Vercel dashboard.
2. Delivery format: `NDJSON`
3. Destination URL: your deployed endpoint, e.g. `https://<your-domain>/api/vercel-log-drain`
4. Custom header:
   - Header name: `x-drain-token`
   - Header value: your `VERCEL_DRAIN_TOKEN`

## Local test

1. Run:

```bash
npm install
npm run dev
```

2. Send one NDJSON log line:

```bash
curl -X POST "http://localhost:3000/api/vercel-log-drain" \
  -H "Content-Type: application/x-ndjson" \
  -H "x-drain-token: $VERCEL_DRAIN_TOKEN" \
  --data-binary $'{"id":"test","deploymentId":"dpl_test","source":"lambda","host":"test.vercel.app","timestamp":1573817187330,"projectId":"proj_test","projectName":"my-app","level":"info","message":"hello from vercel","requestId":"req_test","environment":"production","path":"/api/test","traceId":"trace_test","proxy":{"method":"GET","path":"/api/test","statusCode":200,"region":"sfo1","vercelCache":"MISS","wafAction":"log"}}\n'
```

Expected:

- `200 ok` if Loki is reachable and your credentials are correct.
- `401 unauthorized` if the token is wrong.
- `500` with a Loki error body if the push fails.
