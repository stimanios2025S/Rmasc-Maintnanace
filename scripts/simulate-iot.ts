/**
 * ElevatorPulse – IoT Telemetry Simulator
 *
 * Simulates realistic elevator sensor data and pushes it to the API.
 * Includes periodic synthetic anomalies for testing the alerting system.
 *
 * Usage: npm run simulate-iot
 *    or: npx tsx scripts/simulate-iot.ts
 */

import http from "http";
import https from "https";

// ─── Configuration ──────────────────────────────────────────

const API_BASE = process.env.API_URL || "http://localhost:3000";
const INTERVAL = parseInt(process.env.IOT_SIMULATION_INTERVAL || "2000", 10);
const BATCH_SIZE = 5; // elevators per batch
const INGEST_TOKEN = process.env.IOT_INGEST_TOKEN || "";

// ─── Simulated Elevator Fleet ──────────────────────────────

interface SimElevator {
  code: string;
  brand: string;
  motorAge: number;      // hours
  ropeAge: number;       // hours
  doorAge: number;       // cycles
  vibrationBaseline: number;
  tempBaseline: number;
  degradationPhase: number; // 0-1 (0=healthy, 1=failing)
  anomalyScheduled: number; // tick when anomaly occurs
}

const ELEVATORS: SimElevator[] = [
  {
    code: "EP-BLD01-EL01",
    brand: "OTIS",
    motorAge: 12500,
    ropeAge: 8000,
    doorAge: 145000,
    vibrationBaseline: 2.3,
    tempBaseline: 62,
    degradationPhase: 0.1,
    anomalyScheduled: 50,
  },
  {
    code: "EP-BLD01-EL02",
    brand: "SCHINDLER",
    motorAge: 28000,
    ropeAge: 22000,
    doorAge: 310000,
    vibrationBaseline: 3.1,
    tempBaseline: 68,
    degradationPhase: 0.35,
    anomalyScheduled: 120,
  },
  {
    code: "EP-BLD02-EL01",
    brand: "THYSSENKRUPP",
    motorAge: 45000,
    ropeAge: 38000,
    doorAge: 480000,
    vibrationBaseline: 4.2,
    tempBaseline: 78,
    degradationPhase: 0.6,
    anomalyScheduled: 30,
  },
  {
    code: "EP-BLD02-EL02",
    brand: "KONE",
    motorAge: 5000,
    ropeAge: 3200,
    doorAge: 62000,
    vibrationBaseline: 1.8,
    tempBaseline: 58,
    degradationPhase: 0.05,
    anomalyScheduled: 200,
  },
  {
    code: "EP-BLD03-EL01",
    brand: "MITSUBISHI",
    motorAge: 55000,
    ropeAge: 42000,
    doorAge: 520000,
    vibrationBaseline: 5.1,
    tempBaseline: 88,
    degradationPhase: 0.85,
    anomalyScheduled: 15,
  },
];

// ─── Simulation Engine ──────────────────────────────────────

let tickCount = 0;

function gaussianRandom(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + z * stddev;
}

function simulateElevator(el: SimElevator): any {
  tickCount++;

  // Gradual degradation over time
  const ageFactor = el.motorAge / 60000; // normalized to expected life
  const degradation = el.degradationPhase + ageFactor * 0.2;

  // Simulate vibration with realistic noise
  let vibration = gaussianRandom(
    el.vibrationBaseline * (1 + degradation * 0.5),
    0.3
  );

  // Periodic spike injection (simulates bearing defect)
  const isAnomaly =
    tickCount >= el.anomalyScheduled &&
    tickCount <= el.anomalyScheduled + 5;

  if (isAnomaly) {
    vibration *= 2.5 + Math.random() * 1.5; // 2.5-4x spike
    console.log(
      `  ⚠️  ANOMALY SPIKE: ${el.code} vibration jumped to ${vibration.toFixed(2)} mm/s`
    );
  }

  // Motor temperature follows vibration with lag
  let temperature = gaussianRandom(
    el.tempBaseline * (1 + degradation * 0.3) + vibration * 2,
    1.5
  );

  // Door cycles increment (200-500 per tick, simulating daily operation)
  const newDoorCycles = el.doorAge + Math.floor(Math.random() * 300) + 100;

  // Cabin load varies by time of day pattern
  const hour = new Date().getHours();
  const baseLoad =
    hour >= 8 && hour <= 18 ? 1800 + Math.random() * 2000 : 200 + Math.random() * 800;

  const cabinLoad = gaussianRandom(baseLoad, 200);
  const levelingOffset = gaussianRandom(0, 2 + degradation * 3);

  // Door speed (slightly degrades with age)
  const doorSpeed = gaussianRandom(0.8 - degradation * 0.15, 0.05);

  // Operating hours and brake actuations
  const operatingHours = el.motorAge + 0.01; // increment by ~36 seconds per tick
  const brakeActuations = Math.floor(operatingHours * 3.5); // approx 3.5 per hour

  // Update elevator state for next tick
  el.motorAge = operatingHours;
  el.doorAge = newDoorCycles;

  return {
    elevatorCode: el.code,
    data: {
      motorVibrationMmS: Math.round(vibration * 100) / 100,
      motorTemperatureC: Math.round(temperature * 10) / 10,
      doorCycleCount: newDoorCycles,
      doorSpeedMs: Math.round(doorSpeed * 1000) / 1000,
      cabinLoadKg: Math.round(cabinLoad),
      levelingOffsetMm: Math.round(levelingOffset * 10) / 10,
      operatingHours: Math.round(operatingHours * 100) / 100,
      brakeActuations,
      supplyVoltageV: Math.round(gaussianRandom(400, 5) * 10) / 10,
      currentDrawA: Math.round(gaussianRandom(25 + degradation * 15, 2) * 10) / 10,
    },
  };
}

// ─── HTTP Posting ───────────────────────────────────────────

function postTelemetry(payload: {
  elevatorCode: string;
  data: Record<string, unknown>;
}): Promise<{ alertsGenerated?: number; alerts?: Array<{ severity: string; message: string }>; error?: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL("/api/telemetry", API_BASE);
    const transport = url.protocol === "https:" ? https : http;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(data)),
    };
    if (INGEST_TOKEN) headers["Authorization"] = `Bearer ${INGEST_TOKEN}`;

    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers,
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            if (res.statusCode && res.statusCode >= 400) {
              resolve({ error: (parsed.error as string) ?? `HTTP ${res.statusCode}` });
            } else {
              resolve(parsed as { alertsGenerated?: number; alerts?: Array<{ severity: string; message: string }> });
            }
          } catch {
            resolve({ error: `HTTP ${res.statusCode}: ${body.slice(0, 120)}` });
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Request timed out after 10s"));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ─── Main Loop ──────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════════════╗");
  console.log("║     ElevatorPulse IoT Telemetry Simulator v1.0       ║");
  console.log("╠═══════════════════════════════════════════════════════╣");
  console.log(`║  API Target:  ${API_BASE.padEnd(39)}║`);
  console.log(`║  Interval:    ${(INTERVAL / 1000 + "s").padEnd(39)}║`);
  console.log(`║  Elevators:   ${(ELEVATORS.length + "").padEnd(39)}║`);
  console.log("╚═══════════════════════════════════════════════════════╝");
  console.log();

  let successCount = 0;
  let errorCount = 0;
  let alertCount = 0;

  const loop = async () => {
    const batch = ELEVATORS.slice(0, BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (el) => {
        const payload = simulateElevator(el);
        const result = await postTelemetry(payload);
        return { code: el.code, result };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.result.error) {
          errorCount++;
          console.log(`  ❌ ${r.value.code}: ${r.value.result.error}`);
        } else {
          successCount++;
          const generated = r.value.result.alertsGenerated ?? 0;
          if (generated > 0) {
            alertCount += generated;
            for (const alert of r.value.result.alerts ?? []) {
              console.log(
                `  🔔 ALERT [${alert.severity}] ${r.value.code}: ${alert.message}`
              );
            }
          }
        }
      } else {
        errorCount++;
        console.log(`  ❌ request failed: ${String(r.reason)}`);
      }
    }

    // Summary every 10 ticks
    if (tickCount % 10 === 0) {
      console.log(
        `  📊 Tick ${tickCount} | ✅ ${successCount} success | ❌ ${errorCount} errors | 🔔 ${alertCount} alerts`
      );
    }

    setTimeout(loop, INTERVAL);
  };

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n\n  Simulation stopped.");
    console.log(
      `  Total ticks: ${tickCount} | Success: ${successCount} | Errors: ${errorCount} | Alerts: ${alertCount}`
    );
    process.exit(0);
  });

  console.log("  Starting simulation... Press Ctrl+C to stop.\n");
  loop();
}

main().catch(console.error);
