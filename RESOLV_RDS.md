# Resolv RDS Integration

This project now includes a production-oriented RDS integration runtime in [`resolv.ts`](./resolv.ts).

## What It Adds

- Typed Postgres connectivity (`pg` pool with configurable SSL/pool/timeouts)
- Schema bootstrap for:
  - `customer_profiles`
  - `erp_snapshots`
  - `disruption_alerts`
  - `resilience_cases`
  - `risk_assessments`
  - `mitigation_options`
  - `drafted_actions`
  - `approvals`
  - `audit_events`
- Idempotent case creation via `idempotency_key`
- Risk computation and mitigation ranking using customer risk appetite
- Human approval gate for high-impact disruptions
- Persisted audit trail and drafted communications

## Environment Variables

```bash
RDS_HOST=your-rds-endpoint.amazonaws.com
RDS_PORT=5432
RDS_DB_NAME=resolv
RDS_USERNAME=app_user
RDS_PASSWORD=********
RDS_SSL_MODE=require
RDS_POOL_MAX=15
RDS_IDLE_TIMEOUT_MS=10000
RDS_CONN_TIMEOUT_MS=6000
```

## Bootstrap Schema

```ts
import { ResolvRdsClient, bootstrapResolvSchema } from "./resolv";

const db = ResolvRdsClient.fromEnv();
await bootstrapResolvSchema(db);
await db.close();
```

## Run Agent Workflow

```ts
import { ResolvRdsClient, ResolvAgentService } from "./resolv";

const db = ResolvRdsClient.fromEnv();
const service = new ResolvAgentService(db);

const result = await service.run({
  sku: "MCU-17",
  customerName: "ACME Electronics",
  today: "2026-03-05",
  idempotencyKey: "case-acme-mcu17-2026-03-05",
  metadata: { source: "manual-trigger", priority: "p1" },
});

console.log(result);
await db.close();
```

## Approval Flow

```ts
await service.approveCase({
  caseId: "uuid-case-id",
  approvedBy: "ops.lead@company.com",
  decision: "approved",
  reason: "Air freight budget approved",
});
```

## Health Check

```ts
const health = await db.healthCheck();
console.log(health);
```

