import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { z } from "zod";

export type MitigationOptionKey =
  | "air_freight"
  | "reroute"
  | "allocation_or_buffer";

export type CaseStatus =
  | "analysis_complete"
  | "awaiting_human_approval"
  | "approved"
  | "rejected";

export interface AgentRunInput {
  sku: string;
  customerName: string;
  today: string;
  idempotencyKey?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface CustomerProfile {
  customerName: string;
  lanes: string[];
  criticalSkus: string[];
  slaBreachProbabilityThreshold: number;
  riskAppetite: {
    costWeight: number;
    serviceWeight: number;
  };
}

export interface ErpSnapshot {
  sku: string;
  onHand: number;
  dailyDemand: number;
  inboundQty: number;
  inboundEta: string;
}

export interface DisruptionAlert {
  sku: string;
  alertSource: string;
  affectedLane: string;
  confidence: number;
  predictedDelayDays: number;
  rawAlert: Record<string, unknown>;
}

export interface RiskComputation {
  today: string;
  daysToStockout: number;
  projectedStockoutDate: string;
  originalInboundEta: string;
  newInboundEta: string;
  inboundAfterStockout: boolean;
  gapDays: number;
  slaBreachProbability: number;
}

export interface MitigationEvaluation {
  option: MitigationOptionKey;
  why: string;
  estimatedCostImpact: "low" | "moderate" | "high";
  estimatedServiceImpact: "low" | "moderate" | "high";
  score: number;
}

export interface AgentRunResult {
  caseId: string;
  status: CaseStatus;
  requiresHumanApproval: boolean;
  riskSummary: {
    sku: string;
    customerName: string;
    today: string;
    daysToStockout: number;
    projectedStockoutDate: string;
    originalInboundEta: string;
    newInboundEta: string;
    gapDays: number;
    slaBreachProbability: number;
    whyItMatters: string;
  };
  mitigations: MitigationEvaluation[];
  recommendedPlan: {
    chosenOption: MitigationOptionKey;
    steps: string[];
    decisionRationale: string;
  };
  draftedActions: {
    supplierEmail: string;
    logisticsEmail: string;
    execSummary: string[];
  };
}

const envSchema = z.object({
  RDS_HOST: z.string().min(1),
  RDS_PORT: z.coerce.number().int().positive().default(5432),
  RDS_DB_NAME: z.string().min(1),
  RDS_USERNAME: z.string().min(1),
  RDS_PASSWORD: z.string().min(1),
  RDS_SSL_MODE: z.enum(["disable", "require"]).default("require"),
  RDS_POOL_MAX: z.coerce.number().int().positive().default(15),
  RDS_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  RDS_CONN_TIMEOUT_MS: z.coerce.number().int().positive().default(6_000),
});

const runInputSchema = z.object({
  sku: z.string().min(1),
  customerName: z.string().min(1),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  idempotencyKey: z.string().min(8).max(120).optional(),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

function normalizeDate(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error(`Invalid ISO date: ${value}`);
  }
  return parsed;
}

function addDays(dateValue: string, days: number): string {
  const base = normalizeDate(dateValue);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function daysDiff(startIso: string, endIso: string): number {
  const start = normalizeDate(startIso).valueOf();
  const end = normalizeDate(endIso).valueOf();
  return Math.floor((end - start) / (1000 * 60 * 60 * 24));
}

function calculateSlaBreachProbability(
  gapDays: number,
  delayDays: number,
  confidence: number,
): number {
  const gapFactor = Math.min(1, gapDays / 30);
  const delayFactor = Math.min(1, delayDays / 30);
  const confidenceFactor = Math.min(1, Math.max(0, confidence));
  const p = 0.15 + gapFactor * 0.5 + delayFactor * 0.2 + confidenceFactor * 0.15;
  return Math.min(0.99, Number(p.toFixed(2)));
}

function computeStockoutRisk(
  snapshot: ErpSnapshot,
  alert: DisruptionAlert,
  todayIso: string,
): RiskComputation {
  const daysToStockout =
    snapshot.dailyDemand > 0 ? snapshot.onHand / snapshot.dailyDemand : 1_000_000;
  const roundedDaysToStockout = Number(daysToStockout.toFixed(2));
  const projectedStockoutDate = addDays(todayIso, Math.ceil(daysToStockout));
  const newInboundEta = addDays(snapshot.inboundEta, alert.predictedDelayDays);
  const gapDaysRaw = daysDiff(projectedStockoutDate, newInboundEta);
  const gapDays = Math.max(0, gapDaysRaw);
  const inboundAfterStockout = gapDays > 0;

  return {
    today: todayIso,
    daysToStockout: roundedDaysToStockout,
    projectedStockoutDate,
    originalInboundEta: snapshot.inboundEta,
    newInboundEta,
    inboundAfterStockout,
    gapDays,
    slaBreachProbability: calculateSlaBreachProbability(
      gapDays,
      alert.predictedDelayDays,
      alert.confidence,
    ),
  };
}

function buildMitigations(
  risk: RiskComputation,
  profile: CustomerProfile,
  alert: DisruptionAlert,
): MitigationEvaluation[] {
  const laneIsPrimary = profile.lanes.includes(alert.affectedLane);
  const costWeight = profile.riskAppetite.costWeight;
  const serviceWeight = profile.riskAppetite.serviceWeight;
  const urgency = Math.min(1, risk.gapDays / 30);

  const optionBase: Record<
    MitigationOptionKey,
    {
      cost: number;
      service: number;
      why: string;
      costImpact: "low" | "moderate" | "high";
      serviceImpact: "low" | "moderate" | "high";
    }
  > = {
    air_freight: {
      cost: 0.9,
      service: 0.95,
      why: "Fastest recovery path for a likely stockout; suitable for high-criticality SKUs.",
      costImpact: "high",
      serviceImpact: "low",
    },
    reroute: {
      cost: 0.55,
      service: 0.65,
      why: "Balances timeline and spend by shifting lanes/carriers while avoiding premium uplift.",
      costImpact: "moderate",
      serviceImpact: "moderate",
    },
    allocation_or_buffer: {
      cost: 0.2,
      service: 0.45,
      why: "Lowest direct cost; buys time via internal inventory balancing or customer allocation.",
      costImpact: "low",
      serviceImpact: "high",
    },
  };

  return (Object.keys(optionBase) as MitigationOptionKey[]).map((option) => {
    const base = optionBase[option];
    const laneAdjustment = laneIsPrimary ? 1 : option === "allocation_or_buffer" ? 1.2 : 0.85;
    const criticalSkuBoost = profile.criticalSkus.includes(alert.sku) ? 1.1 : 1;
    const serviceScore = base.service * serviceWeight * urgency * laneAdjustment * criticalSkuBoost;
    const costPenalty = base.cost * costWeight;
    const score = Number((serviceScore - costPenalty).toFixed(4));

    return {
      option,
      why: base.why,
      estimatedCostImpact: base.costImpact,
      estimatedServiceImpact: base.serviceImpact,
      score,
    };
  });
}

function chooseOption(mitigations: MitigationEvaluation[]): MitigationOptionKey {
  const sorted = [...mitigations].sort((a, b) => b.score - a.score);
  return sorted[0]?.option ?? "allocation_or_buffer";
}

function buildDecisionRationale(
  option: MitigationOptionKey,
  risk: RiskComputation,
  profile: CustomerProfile,
): string {
  const riskBand =
    risk.slaBreachProbability > 0.7
      ? "severe"
      : risk.slaBreachProbability > 0.4
        ? "elevated"
        : "moderate";
  return `Selected ${option} because the current risk profile is ${riskBand} (gap=${risk.gapDays} days, SLA breach=${risk.slaBreachProbability}), aligned with cost_weight=${profile.riskAppetite.costWeight} and service_weight=${profile.riskAppetite.serviceWeight}.`;
}

function buildEmailDrafts(
  input: AgentRunInput,
  risk: RiskComputation,
  option: MitigationOptionKey,
): AgentRunResult["draftedActions"] {
  const supplierEmail = [
    `Subject: Urgent mitigation request for ${input.sku}`,
    "",
    "Dear Supplier Team,",
    "",
    `We identified a disruption risk for SKU ${input.sku}.`,
    `Projected stockout: ${risk.projectedStockoutDate}.`,
    `Current inbound ETA shifted from ${risk.originalInboundEta} to ${risk.newInboundEta}.`,
    `Recommended mitigation: ${option}.`,
    "",
    "Please confirm recovery options, feasible quantities, and lead-time impact today.",
    "",
    "Regards,",
    "Resilience Operations",
  ].join("\n");

  const logisticsEmail = [
    `Subject: Execute ${option} plan for ${input.sku}`,
    "",
    "Logistics Team,",
    "",
    `Gap to inbound after stockout: ${risk.gapDays} day(s).`,
    `SLA breach probability: ${risk.slaBreachProbability}.`,
    `Please prepare execution workflow for option: ${option}.`,
    "",
    "Required outputs:",
    "1) Transit plan and cost delta",
    "2) Capacity confirmation",
    "3) Earliest recoverable ETA",
    "",
    "Thanks,",
    "Resilience Agent",
  ].join("\n");

  const execSummary = [
    `${input.sku} is projected to stock out on ${risk.projectedStockoutDate}.`,
    `Inbound moved to ${risk.newInboundEta}, creating a ${risk.gapDays}-day exposure.`,
    `Estimated SLA breach probability is ${risk.slaBreachProbability}.`,
    `Recommended mitigation is ${option} based on weighted risk appetite optimization.`,
    "Approval gate is enforced automatically for high-impact scenarios.",
  ];

  return { supplierEmail, logisticsEmail, execSummary };
}

export class ResolvRdsClient {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ResolvRdsClient {
    const cfg = envSchema.parse(env);
    return new ResolvRdsClient({
      host: cfg.RDS_HOST,
      port: cfg.RDS_PORT,
      database: cfg.RDS_DB_NAME,
      user: cfg.RDS_USERNAME,
      password: cfg.RDS_PASSWORD,
      max: cfg.RDS_POOL_MAX,
      idleTimeoutMillis: cfg.RDS_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: cfg.RDS_CONN_TIMEOUT_MS,
      ssl: cfg.RDS_SSL_MODE === "require" ? { rejectUnauthorized: false } : false,
      application_name: "resolv-agent",
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async healthCheck(): Promise<{
    dbTime: string;
    activeConnections: number;
    idleConnections: number;
  }> {
    const [timeRes, connRes] = await Promise.all([
      this.pool.query<{ now: string }>("select now()::text as now"),
      this.pool.query<{ active: string; idle: string }>(
        "select count(*) filter (where state = 'active')::text as active, count(*) filter (where state = 'idle')::text as idle from pg_stat_activity where datname = current_database()",
      ),
    ]);
    return {
      dbTime: timeRes.rows[0]?.now ?? new Date().toISOString(),
      activeConnections: Number(connRes.rows[0]?.active ?? 0),
      idleConnections: Number(connRes.rows[0]?.idle ?? 0),
    };
  }

  async withTransaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const output = await handler(client);
      await client.query("commit");
      return output;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function upsertCase(
  client: PoolClient,
  input: AgentRunInput,
  status: CaseStatus,
  metadataJson: Record<string, unknown>,
): Promise<{ id: string; reused: boolean }> {
  const idempotencyKey = input.idempotencyKey ?? `${input.customerName}:${input.sku}:${input.today}`;
  const existing = await client.query<{ id: string }>(
    "select id from resilience_cases where idempotency_key = $1 limit 1",
    [idempotencyKey],
  );
  if (existing.rowCount && existing.rows[0]) {
    return { id: existing.rows[0].id, reused: true };
  }

  const id = randomUUID();
  await client.query(
    `insert into resilience_cases
      (id, customer_name, sku, analysis_date, status, idempotency_key, metadata_json)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [id, input.customerName, input.sku, input.today, status, idempotencyKey, JSON.stringify(metadataJson)],
  );
  return { id, reused: false };
}

async function fetchLatestSnapshot(client: PoolClient, sku: string): Promise<ErpSnapshot> {
  const row = await client.query<{
    sku: string;
    on_hand: number;
    daily_demand: number;
    inbound_qty: number;
    inbound_eta: string;
  }>(
    `select sku, on_hand, daily_demand, inbound_qty, inbound_eta::text
     from erp_snapshots
     where sku = $1
     order by snapshot_ts desc
     limit 1`,
    [sku],
  );
  if (!row.rows[0]) {
    throw new Error(`No ERP snapshot found for sku=${sku}`);
  }
  return {
    sku: row.rows[0].sku,
    onHand: Number(row.rows[0].on_hand),
    dailyDemand: Number(row.rows[0].daily_demand),
    inboundQty: Number(row.rows[0].inbound_qty),
    inboundEta: row.rows[0].inbound_eta.slice(0, 10),
  };
}

async function fetchLatestAlert(client: PoolClient, sku: string): Promise<DisruptionAlert> {
  const row = await client.query<{
    sku: string;
    alert_source: string;
    affected_lane: string;
    confidence: number;
    predicted_delay_days: number;
    raw_alert_json: Record<string, unknown>;
  }>(
    `select sku, alert_source, affected_lane, confidence, predicted_delay_days, raw_alert_json
     from disruption_alerts
     where sku = $1
     order by created_at desc
     limit 1`,
    [sku],
  );
  if (!row.rows[0]) {
    throw new Error(`No disruption alert found for sku=${sku}`);
  }
  return {
    sku: row.rows[0].sku,
    alertSource: row.rows[0].alert_source,
    affectedLane: row.rows[0].affected_lane,
    confidence: Number(row.rows[0].confidence),
    predictedDelayDays: Number(row.rows[0].predicted_delay_days),
    rawAlert: row.rows[0].raw_alert_json,
  };
}

async function fetchCustomerProfile(
  client: PoolClient,
  customerName: string,
): Promise<CustomerProfile> {
  const row = await client.query<{
    customer_name: string;
    lanes: string[];
    critical_skus: string[];
    sla_breach_probability_threshold: number;
    cost_weight: number;
    service_weight: number;
  }>(
    `select customer_name, lanes, critical_skus, sla_breach_probability_threshold, cost_weight, service_weight
     from customer_profiles
     where customer_name = $1
     limit 1`,
    [customerName],
  );
  if (!row.rows[0]) {
    throw new Error(`No customer profile found for customer=${customerName}`);
  }
  return {
    customerName: row.rows[0].customer_name,
    lanes: row.rows[0].lanes ?? [],
    criticalSkus: row.rows[0].critical_skus ?? [],
    slaBreachProbabilityThreshold: Number(row.rows[0].sla_breach_probability_threshold),
    riskAppetite: {
      costWeight: Number(row.rows[0].cost_weight),
      serviceWeight: Number(row.rows[0].service_weight),
    },
  };
}

async function insertAuditEvent(
  client: PoolClient,
  caseId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `insert into audit_events (id, case_id, event_type, payload_json)
     values ($1, $2, $3, $4::jsonb)`,
    [randomUUID(), caseId, eventType, JSON.stringify(payload)],
  );
}

export async function bootstrapResolvSchema(db: ResolvRdsClient): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(`
      create table if not exists customer_profiles (
        customer_name text primary key,
        lanes text[] not null default '{}',
        critical_skus text[] not null default '{}',
        sla_breach_probability_threshold numeric(5,4) not null,
        cost_weight numeric(6,4) not null,
        service_weight numeric(6,4) not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists erp_snapshots (
        id uuid primary key,
        sku text not null,
        on_hand numeric(14,3) not null,
        daily_demand numeric(14,3) not null,
        inbound_qty numeric(14,3) not null,
        inbound_eta date not null,
        snapshot_ts timestamptz not null default now()
      );
      create index if not exists idx_erp_snapshots_sku_ts on erp_snapshots (sku, snapshot_ts desc);

      create table if not exists disruption_alerts (
        id uuid primary key,
        sku text not null,
        alert_source text not null,
        affected_lane text not null,
        confidence numeric(6,4) not null,
        predicted_delay_days integer not null,
        raw_alert_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_disruption_alerts_sku_ts on disruption_alerts (sku, created_at desc);

      create table if not exists resilience_cases (
        id uuid primary key,
        customer_name text not null,
        sku text not null,
        analysis_date date not null,
        status text not null,
        idempotency_key text not null unique,
        metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists risk_assessments (
        id uuid primary key,
        case_id uuid not null references resilience_cases(id) on delete cascade,
        today date not null,
        days_to_stockout numeric(14,3) not null,
        projected_stockout_date date not null,
        original_inbound_eta date not null,
        new_inbound_eta date not null,
        gap_days integer not null,
        sla_breach_probability numeric(5,4) not null,
        why_it_matters text not null,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_risk_assessments_case_id on risk_assessments(case_id);

      create table if not exists mitigation_options (
        id uuid primary key,
        case_id uuid not null references resilience_cases(id) on delete cascade,
        option_key text not null,
        why text not null,
        estimated_cost_impact text not null,
        estimated_service_impact text not null,
        score numeric(14,6) not null,
        is_recommended boolean not null default false,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_mitigation_options_case_id on mitigation_options(case_id);

      create table if not exists drafted_actions (
        id uuid primary key,
        case_id uuid not null references resilience_cases(id) on delete cascade,
        supplier_email text not null,
        logistics_email text not null,
        exec_summary_json jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_drafted_actions_case_id on drafted_actions(case_id);

      create table if not exists approvals (
        id uuid primary key,
        case_id uuid not null references resilience_cases(id) on delete cascade,
        approved_by text not null,
        approved_at timestamptz not null default now(),
        decision text not null,
        reason text
      );
      create index if not exists idx_approvals_case_id on approvals(case_id);

      create table if not exists audit_events (
        id uuid primary key,
        case_id uuid not null references resilience_cases(id) on delete cascade,
        event_type text not null,
        payload_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists idx_audit_events_case_id on audit_events(case_id);
    `);
  });
}

export class ResolvAgentService {
  constructor(private readonly db: ResolvRdsClient) {}

  async run(inputRaw: AgentRunInput): Promise<AgentRunResult> {
    const input = runInputSchema.parse(inputRaw);
    const defaultMetadata = input.metadata ?? {};
    return this.db.withTransaction(async (client) => {
      const [snapshot, alert, profile] = await Promise.all([
        fetchLatestSnapshot(client, input.sku),
        fetchLatestAlert(client, input.sku),
        fetchCustomerProfile(client, input.customerName),
      ]);

      const risk = computeStockoutRisk(snapshot, alert, input.today);
      const laneIsPrimary = profile.lanes.includes(alert.affectedLane);
      const mitigations = buildMitigations(risk, profile, alert);
      const chosenOption = chooseOption(mitigations);
      const highImpact =
        risk.gapDays > 0 || risk.slaBreachProbability > profile.slaBreachProbabilityThreshold;
      const status: CaseStatus = highImpact
        ? "awaiting_human_approval"
        : "analysis_complete";

      const whyItMatters = laneIsPrimary
        ? `Disruption lane ${alert.affectedLane} affects a primary customer lane. Exposure is ${risk.gapDays} day(s) with SLA breach probability ${risk.slaBreachProbability}.`
        : `Alert lane ${alert.affectedLane} is outside primary lanes for ${profile.customerName}; mitigation is prioritized toward allocation and monitoring unless risk escalates.`;

      const caseRef = await upsertCase(client, input, status, {
        ...defaultMetadata,
        alertSource: alert.alertSource,
      });

      if (!caseRef.reused) {
        await client.query(
          `insert into risk_assessments
            (id, case_id, today, days_to_stockout, projected_stockout_date, original_inbound_eta, new_inbound_eta, gap_days, sla_breach_probability, why_it_matters)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            randomUUID(),
            caseRef.id,
            risk.today,
            risk.daysToStockout,
            risk.projectedStockoutDate,
            risk.originalInboundEta,
            risk.newInboundEta,
            risk.gapDays,
            risk.slaBreachProbability,
            whyItMatters,
          ],
        );

        for (const mitigation of mitigations) {
          await client.query(
            `insert into mitigation_options
              (id, case_id, option_key, why, estimated_cost_impact, estimated_service_impact, score, is_recommended)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              randomUUID(),
              caseRef.id,
              mitigation.option,
              mitigation.why,
              mitigation.estimatedCostImpact,
              mitigation.estimatedServiceImpact,
              mitigation.score,
              mitigation.option === chosenOption,
            ],
          );
        }

        const draftedActions = buildEmailDrafts(input, risk, chosenOption);
        await client.query(
          `insert into drafted_actions
            (id, case_id, supplier_email, logistics_email, exec_summary_json)
           values ($1, $2, $3, $4, $5::jsonb)`,
          [
            randomUUID(),
            caseRef.id,
            draftedActions.supplierEmail,
            draftedActions.logisticsEmail,
            JSON.stringify(draftedActions.execSummary),
          ],
        );

        await insertAuditEvent(client, caseRef.id, "analysis_completed", {
          input,
          chosenOption,
          highImpact,
          laneIsPrimary,
        });
      }

      const draftedActionsRow = await client.query<{
        supplier_email: string;
        logistics_email: string;
        exec_summary_json: string[];
      }>(
        `select supplier_email, logistics_email, exec_summary_json
         from drafted_actions where case_id = $1 order by created_at desc limit 1`,
        [caseRef.id],
      );

      const plannedSteps = highImpact
        ? [
            "Require human approval before sending emails / executing changes.",
            "Confirm recovered ETA with logistics.",
            "Notify supplier and customer operations.",
          ]
        : [
            "Proceed with mitigation execution.",
            "Confirm recovered ETA with logistics.",
            "Notify supplier and customer operations.",
          ];

      const output: AgentRunResult = {
        caseId: caseRef.id,
        status,
        requiresHumanApproval: highImpact,
        riskSummary: {
          sku: input.sku,
          customerName: input.customerName,
          today: risk.today,
          daysToStockout: risk.daysToStockout,
          projectedStockoutDate: risk.projectedStockoutDate,
          originalInboundEta: risk.originalInboundEta,
          newInboundEta: risk.newInboundEta,
          gapDays: risk.gapDays,
          slaBreachProbability: risk.slaBreachProbability,
          whyItMatters,
        },
        mitigations,
        recommendedPlan: {
          chosenOption,
          steps: plannedSteps,
          decisionRationale: buildDecisionRationale(chosenOption, risk, profile),
        },
        draftedActions: {
          supplierEmail: draftedActionsRow.rows[0]?.supplier_email ?? "",
          logisticsEmail: draftedActionsRow.rows[0]?.logistics_email ?? "",
          execSummary: draftedActionsRow.rows[0]?.exec_summary_json ?? [],
        },
      };

      return output;
    });
  }

  async approveCase(input: {
    caseId: string;
    approvedBy: string;
    decision: "approved" | "rejected";
    reason?: string;
  }): Promise<{ caseId: string; status: CaseStatus }> {
    return this.db.withTransaction(async (client) => {
      const existing = await client.query<{ id: string; status: CaseStatus }>(
        "select id, status from resilience_cases where id = $1 limit 1",
        [input.caseId],
      );
      if (!existing.rows[0]) {
        throw new Error(`Case not found: ${input.caseId}`);
      }

      const nextStatus: CaseStatus =
        input.decision === "approved" ? "approved" : "rejected";
      await client.query(
        `insert into approvals (id, case_id, approved_by, decision, reason)
         values ($1, $2, $3, $4, $5)`,
        [randomUUID(), input.caseId, input.approvedBy, input.decision, input.reason ?? null],
      );
      await client.query(
        "update resilience_cases set status = $2, updated_at = now() where id = $1",
        [input.caseId, nextStatus],
      );
      await insertAuditEvent(client, input.caseId, "approval_recorded", {
        approvedBy: input.approvedBy,
        decision: input.decision,
        reason: input.reason ?? null,
      });
      return { caseId: input.caseId, status: nextStatus };
    });
  }
}

export async function runWithEnv(input: AgentRunInput): Promise<AgentRunResult> {
  const db = ResolvRdsClient.fromEnv();
  const service = new ResolvAgentService(db);
  try {
    return await service.run(input);
  } finally {
    await db.close();
  }
}
