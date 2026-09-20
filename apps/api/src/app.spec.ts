import { INestApplication, ValidationPipe } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import bs58 from "bs58";
import { randomBytes } from "crypto";
import request from "supertest";
import { FaucetController } from "./faucet/faucet.controller";
import { HealthController } from "./health/health.controller";
import { CacheService } from "./infra/cache.service";
import { PoolSummary } from "./lib/ranking";
import { PoolsController } from "./pools/pools.controller";
import { PoolsRepo } from "./pools/pools.repo";
import { RiskController } from "./risk/risk.controller";
import { SeriesController } from "./series/series.controller";
import { PositionRow, SeriesRepo, SeriesRow } from "./series/series.repo";
import { WalletController } from "./wallet/wallet.controller";

const D = 1_000_000n;
const T = "2026-01-01T00:00:00.000Z";
const pool = (o: Partial<PoolSummary> & { id: string }): PoolSummary => ({
  name: o.id, category: "lending", chain: "solana", data_source: "seed-synthetic", headline_apy: 0.08, realized_apy_7d: 0.05,
  realized_apy_30d: 0.05, realized_basis: "share_rate", emissions_share: 0.1, mostly_bonus_tokens: false,
  gap: { advertised: 0.08, realized: 0.05, gap_points: 0.03 }, tvl_usd: 1e8, sparkline_30d: [], risk_score: 80, sustainable_realized_apy: 0.05,
  risk_adjusted_yield: 0.04, updated_at: T, ...o,
});
const POOLS = [
  pool({ id: "safe", risk_score: 90 }),
  pool({ id: "degen", risk_score: 28, headline_apy: 0.38, emissions_share: 0.92, mostly_bonus_tokens: true, sustainable_realized_apy: 0.23 }),
];
const SERIES: SeriesRow = {
  id: "7", pubkey: "SeriesPubkey", status: "settled", rate_bps: 200, term_secs: 180, decimals: 6, senior_principal: 100n * D, junior_principal: 20n * D,
  senior_payout: 100_000_011n, junior_payout: 27_199_989n, min_junior_bps: 1000, min_risk_score: 60, deposit_deadline: new Date("2026-01-01"),
  start_ts: new Date("2026-01-01"), maturity_ts: new Date("2026-01-01T00:03:00Z"), underlying_mint: "m", senior_mint: "sm", junior_mint: "jm",
  vault: "v", strategy_pool: "sp", risk_entry: "re", protocol_id: "safe", risk_score: 90, risk_expires_at: new Date("2026-01-02"), created_at: new Date(T), updated_at: new Date(T),
};
const newAddress = () => bs58.encode(randomBytes(32));
const OWNER = newAddress();

let listCalls = 0;
const poolsRepo = {
  listPools: async () => (listCalls++, POOLS),
  getPool: async (id: string) => POOLS.find((p) => p.id === id) ?? null,
  getRisk: async (id: string) => (id === "safe" ? { protocol_id: id, score: 90, breakdown: [{ factor: "tvl" }], sources: [{ url: "https://example.org/a", quote: "q" }], explanation: "Solid.", explanation_source: "cache", computed_at: T } : null),
  history: async (id: string) => (id === "safe" ? [{ ts: T, tvl_usd: 1, apy_headline: 0.08, apy_base: 0.06, apy_reward: 0.02, share_rate: 1 }] : []),
};
const seriesRepo = {
  list: async () => [SERIES],
  get: async (id: string) => (id === "7" ? SERIES : id === "8" ? { ...SERIES, id: "8", status: "open", senior_principal: 0n, junior_principal: 100n * D, maturity_ts: null, deposit_deadline: new Date(Date.now() + 86_400_000) } : null),
  positions: async (owner: string): Promise<PositionRow[]> => (owner === OWNER ? [{ series: SERIES, tranche: "senior", principal: 100n * D, claimed: false }] : []),
};

describe("API (fake repositories)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1000 }])],
      controllers: [HealthController, PoolsController, RiskController, SeriesController, WalletController, FaucetController],
      providers: [
        { provide: PoolsRepo, useValue: poolsRepo }, { provide: SeriesRepo, useValue: seriesRepo },
        { provide: CacheService, useValue: { wrap: (_k: string, _t: number, f: () => unknown) => f() } },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
  });
  afterAll(() => app.close());
  const http = () => request(app.getHttpServer());

  it("health on /health and /v1/health", async () => {
    for (const p of ["/health", "/v1/health"]) expect((await http().get(p)).status).toBe(200);
  });

  describe("pools", () => {
    it("ranks with the balanced profile by default and reports why pools were excluded", async () => {
      const r = await http().get("/v1/pools").expect(200);
      expect(r.body.profile).toBe("balanced");
      expect(r.body.data.map((p: any) => p.id)).toEqual(["safe"]);
      expect(r.body.excluded).toEqual([{ id: "degen", reason: expect.stringContaining("below the balanced minimum") }]);
      expect(r.body.updated_at).toBe(T);
      expect(r.body.data[0]).toMatchObject({ rank: 1, gap: { gap_points: 0.03 }, mostly_bonus_tokens: false });
    });
    it("aggressive profile includes the bonus-token pool and flags it", async () => {
      const r = await http().get("/v1/pools?profile=aggressive&sort=headline").expect(200);
      expect(r.body.data[0]).toMatchObject({ id: "degen", mostly_bonus_tokens: true });
    });
    it.each(["/v1/pools?profile=yolo", "/v1/pools?sort=vibes", "/v1/pools?extra=1", "/v1/pools/UPPER", "/v1/pools/a%20b", "/v1/pools/safe/history?window=1y"])("400 on %s", async (url) => {
      await http().get(url).expect(400);
    });
    it("detail includes cited risk explanation; unknown is 404", async () => {
      const r = await http().get("/v1/pools/safe").expect(200);
      expect(r.body.risk).toMatchObject({ score: 90, explanation: "Solid.", explanation_source: "cache" });
      expect(r.body.risk.sources.length).toBeGreaterThan(0);
      await http().get("/v1/pools/nope").expect(404);
    });
    it("history", async () => {
      const r = await http().get("/v1/pools/safe/history?window=7d").expect(200);
      expect(r.body).toMatchObject({ window: "7d", updated_at: T });
      await http().get("/v1/pools/degen/history").expect(404);
    });
  });

  describe("risk", () => {
    it("GET and POST explain serve stored, cited output and never call a model", async () => {
      const g = await http().get("/v1/risk/safe").expect(200);
      expect(g.body).toMatchObject({ score: 90, computed_at: T, updated_at: T });
      const e = await http().post("/v1/risk/safe/explain").expect(200);
      expect(e.body).toMatchObject({ explanation: "Solid.", served_from: "cache" });
      await http().get("/v1/risk/degen").expect(404);
      await http().post("/v1/risk/degen/explain").expect(404);
    });
  });

  describe("series", () => {
    it("lists and gets a series with a disclaimer and updated_at", async () => {
      const l = await http().get("/v1/series").expect(200);
      expect(l.body.data[0]).toMatchObject({ id: "7", status: "settled", senior_target: "100.000011", senior_payout: "100.000011", junior_payout: "27.199989" });
      expect(l.body.disclaimer).toBe("Target rate, not guaranteed. Devnet prototype. Informational only, not financial advice.");
      const g = await http().get("/v1/series/7").expect(200);
      expect(g.body.updated_at).toBe(T);
      expect(g.body).toMatchObject({ protocol_id: "safe", risk_score: 90, senior_capacity: "180", junior_needed: "11.111111", created_at: T });
      expect(g.body.realized_period_return).toBeCloseTo(0.06, 4);
      expect(g.body.realized_apy).toBeNull(); // 3 minute term: never annualised
      await http().get("/v1/series/999").expect(404);
      for (const bad of ["abc", "-1", "01", "18446744073709551616"]) await http().get(`/v1/series/${bad}`).expect(400);
    });
    it("quote returns a target term sheet and scenarios", async () => {
      const r = await http().get("/v1/series/8/quote?amount=100&tranche=senior").expect(200);
      expect(r.body).toMatchObject({ tranche: "senior", amount: "100", target_rate_bps: 200, open_for_deposits: true, capacity: { ok: true } });
      expect(r.body.target_payout).toMatch(/^100\.0000\d+$/); // 2% APR pro-rated to a 3 minute term
      expect(r.body.scenarios).toHaveLength(5);
      expect(r.body.disclaimer).toContain("not guaranteed");
    });
    it.each(["amount=0&tranche=senior", "amount=-5&tranche=senior", "amount=abc&tranche=senior", "amount=1&tranche=mezz", "tranche=senior", "amount=1.1234567&tranche=senior"])("quote 400 on %s", async (qs) => {
      await http().get(`/v1/series/8/quote?${qs}`).expect(400);
    });
    it("simulate matches the waterfall and validates input", async () => {
      const r = await http().post("/v1/series/7/simulate").send({ yieldBps: -2000 }).expect(200);
      expect(r.body).toMatchObject({ senior_shortfall: true, junior_wiped_out: true, junior_payout: "0" });
      for (const bad of [{}, { yieldBps: "x" }, { yieldBps: 1.5 }, { yieldBps: -10001 }, { yieldBps: 1, extra: true }]) {
        await http().post("/v1/series/7/simulate").send(bad).expect(400);
      }
    });
  });

  describe("wallet", () => {
    it("shows advertised vs realized for a settled position", async () => {
      const r = await http().post("/v1/wallet/positions").send({ address: OWNER }).expect(200);
      expect(r.body.positions[0]).toMatchObject({
        series_id: "7", tranche: "senior", principal: "100", claimed: false, claimable: "100.000011",
        advertised: { target_rate_bps: 200 }, realized: { payout: "100.000011", annualized: null },
      });
      expect(r.body.notes[0]).toMatch(/external protocols/);
    });
    it("empty wallet is fine; junk addresses are rejected", async () => {
      const r = await http().post("/v1/wallet/positions").send({ address: newAddress() }).expect(200);
      expect(r.body.positions).toEqual([]);
      for (const address of ["", "not-a-key", "1".repeat(33), "0x" + "a".repeat(40)]) await http().post("/v1/wallet/positions").send({ address }).expect(400);
    });
  });

  describe("faucet", () => {
    const spy = () => jest.spyOn(global, "fetch");
    afterEach(() => jest.restoreAllMocks());

    it("forwards a valid address to the keeper and passes the result through", async () => {
      const f = spy().mockResolvedValue(new Response(JSON.stringify({ signature: "sig", tokens: 1000, sol: 0.05 }), { status: 200 }));
      const address = newAddress();
      const r = await http().post("/v1/faucet").send({ address }).expect(200);
      expect(r.body).toMatchObject({ signature: "sig", tokens: 1000 });
      expect(r.body.disclaimer).toContain("Devnet test tokens");
      expect(String(f.mock.calls[0][0])).toMatch(/\/faucet$/);
      expect(JSON.parse((f.mock.calls[0][1] as RequestInit).body as string)).toEqual({ address });
    });
    it("never reaches the keeper for junk addresses", async () => {
      const f = spy();
      for (const address of ["", "nope", 5]) await http().post("/v1/faucet").send({ address }).expect(400);
      expect(f).not.toHaveBeenCalled();
    });
    it("relays the cooldown and hides keeper failures", async () => {
      spy().mockResolvedValueOnce(new Response(JSON.stringify({ error: "faucet cooldown", retry_after_secs: 900 }), { status: 429 }));
      const r = await http().post("/v1/faucet").send({ address: newAddress() }).expect(429);
      expect(r.body).toMatchObject({ retry_after_secs: 900 });
      spy().mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await http().post("/v1/faucet").send({ address: newAddress() }).expect(503);
      spy().mockResolvedValueOnce(new Response("{}", { status: 404 }));
      await http().post("/v1/faucet").send({ address: newAddress() }).expect(503);
    });
  });

  it("no response ever promises returns (banned words)", async () => {
    const urls = ["/v1/pools", "/v1/pools/safe", "/v1/risk/safe", "/v1/series", "/v1/series/8/quote?amount=100&tranche=senior", "/v1/series/8/quote?amount=10&tranche=junior"];
    for (const u of urls) {
      const body = JSON.stringify((await http().get(u)).body).toLowerCase();
      for (const w of ["guaranteed", "risk-free", "assured", "safe returns"]) {
        // the mandated disclaimer says "not guaranteed"; anything else must not contain the word
        expect(body.replace(/not guaranteed/g, "")).not.toContain(w);
      }
    }
  });
});

describe("rate limiting", () => {
  it("returns 429 past the limit but never for /health", async () => {
    const mod = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 3 }])],
      controllers: [HealthController, PoolsController],
      providers: [{ provide: PoolsRepo, useValue: poolsRepo }, { provide: CacheService, useValue: { wrap: (_k: string, _t: number, f: () => unknown) => f() } }, { provide: APP_GUARD, useClass: ThrottlerGuard }],
    }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await request(app.getHttpServer()).get("/v1/pools")).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    for (let i = 0; i < 6; i++) expect((await request(app.getHttpServer()).get("/health")).status).toBe(200);
    await app.close();
  });
});
