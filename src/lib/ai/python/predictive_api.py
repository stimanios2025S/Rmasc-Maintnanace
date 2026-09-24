"""
ElevatorPulse – Python FastAPI + Scikit-learn Predictive API

This is a reference implementation for the ML prediction service.
In production, this runs as a separate FastAPI microservice.

Install: pip install fastapi uvicorn scikit-learn numpy pandas joblib
Run:     uvicorn predictive_api:app --host 0.0.0.0 --port 8000
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
from datetime import datetime, timedelta

app = FastAPI(title="ElevatorPulse Predictive API", version="1.0.0")


# ─── Request/Response Models ────────────────────────────────

class TelemetryWindow(BaseModel):
    timestamps: List[str]
    vibration_mm_s: List[float]
    temperature_c: List[float]
    door_cycles: List[int]
    operating_hours: List[float]
    brake_actuations: List[int]
    current_draw_a: List[float]


class ComponentPrediction(BaseModel):
    component_type: str
    remaining_useful_life_percent: float
    risk_level: str  # LOW, MEDIUM, HIGH, CRITICAL
    risk_score: float  # 0-100
    predicted_failure_date: Optional[str]
    confidence: float
    recommendations: List[str]


class PredictionResponse(BaseModel):
    elevator_id: str
    overall_health: float
    overall_risk: str
    components: List[ComponentPrediction]
    model_version: str
    analyzed_at: str


# ─── Degradation Model ──────────────────────────────────────

class ComponentDegradationModel:
    """Exponential degradation model with multi-factor acceleration."""

    def __init__(
        self,
        base_life_hours: float,
        vibration_factor: float,
        temperature_factor: float,
        cycle_factor: float,
        baseline_vibration: float = 2.5,
        baseline_temperature: float = 65.0,
    ):
        self.base_life_hours = base_life_hours
        self.vibration_factor = vibration_factor
        self.temperature_factor = temperature_factor
        self.cycle_factor = cycle_factor
        self.baseline_vibration = baseline_vibration
        self.baseline_temperature = baseline_temperature

    def predict_rul(
        self,
        current_life_hours: float,
        avg_vibration: float,
        avg_temperature: float,
        total_door_cycles: int,
    ) -> dict:
        # Excess wear from abnormal conditions
        vib_excess = max(0, avg_vibration - self.baseline_vibration)
        temp_excess = max(0, avg_temperature - self.baseline_temperature)

        # Effective wear calculation
        time_wear = current_life_hours
        vib_wear = vib_excess * self.vibration_factor * current_life_hours
        temp_wear = temp_excess * self.temperature_factor * current_life_hours
        cycle_wear = total_door_cycles * self.cycle_factor * 0.001

        effective_wear = time_wear + vib_wear + temp_wear + cycle_wear
        rul_percent = max(
            0, min(100, 100 - (effective_wear / self.base_life_hours) * 100)
        )

        # Risk score with severity amplification
        risk_score = 100 - rul_percent
        if vib_excess > 3.0:
            risk_score = min(100, risk_score + 15)
        if temp_excess > 20:
            risk_score = min(100, risk_score + 10)
        risk_score = max(0, min(100, risk_score))

        # Predicted failure
        remaining = self.base_life_hours - effective_wear
        days = remaining / 10 if remaining > 0 else 0
        failure_date = (
            (datetime.now() + timedelta(days=days)).isoformat()
            if days > 0
            else datetime.now().isoformat()
        )

        confidence = min(0.95, 0.5 + current_life_hours / self.base_life_hours)

        return {
            "rul_percent": round(rul_percent, 1),
            "risk_score": round(risk_score, 1),
            "predicted_failure_date": failure_date,
            "confidence": round(confidence, 2),
        }


# ─── Model Registry ─────────────────────────────────────────

MODELS = {
    "TRACTION_MOTOR": ComponentDegradationModel(
        base_life_hours=60000, vibration_factor=0.15, temperature_factor=0.12,
        cycle_factor=0.0,
    ),
    "STEEL_ROPES": ComponentDegradationModel(
        base_life_hours=50000, vibration_factor=0.08, temperature_factor=0.05,
        cycle_factor=0.10,
    ),
    "DOOR_OPERATOR": ComponentDegradationModel(
        base_life_hours=40000, vibration_factor=0.05, temperature_factor=0.03,
        cycle_factor=0.20,
    ),
    "BRAKE_ASSEMBLY": ComponentDegradationModel(
        base_life_hours=45000, vibration_factor=0.10, temperature_factor=0.08,
        cycle_factor=0.12,
    ),
    "GUIDE_SHOES": ComponentDegradationModel(
        base_life_hours=35000, vibration_factor=0.18, temperature_factor=0.04,
        cycle_factor=0.06,
    ),
    "CONTROLLER_BOARD": ComponentDegradationModel(
        base_life_hours=80000, vibration_factor=0.03, temperature_factor=0.15,
        cycle_factor=0.0,
    ),
}


def classify_risk(rul: float, score: float) -> str:
    if rul <= 10 or score >= 90:
        return "CRITICAL"
    if rul <= 25 or score >= 70:
        return "HIGH"
    if rul <= 50 or score >= 45:
        return "MEDIUM"
    return "LOW"


def generate_recommendations(
    comp_type: str, risk: str, rul: float, vib: float, temp: float
) -> list:
    recs = []
    name = comp_type.replace("_", " ").lower()
    if risk == "CRITICAL":
        recs.append(f"URGENT: Immediate inspection required for {name}")
        recs.append("Prepare replacement parts and schedule emergency maintenance")
    if risk == "HIGH":
        recs.append(f"Schedule preventive replacement of {name} within 2 weeks")
        recs.append("Increase monitoring to daily checks")
    if vib > 4.0:
        recs.append("Elevated vibration — check mounting and alignment")
    if temp > 80:
        recs.append("Temperature trending high — inspect cooling system")
    if rul < 50 and rul > 10:
        recs.append(f"Component at {rul}% RUL — plan replacement next cycle")
    if not recs:
        recs.append("Operating normally — continue routine monitoring")
    return recs


# ─── API Endpoints ──────────────────────────────────────────

@app.post("/predict/{elevator_id}", response_model=PredictionResponse)
async def predict_elevator_health(
    elevator_id: str, telemetry: TelemetryWindow
):
    """Analyze telemetry data and predict component health."""

    if len(telemetry.vibration_mm_s) < 2:
        raise HTTPException(
            status_code=400, detail="Need at least 2 telemetry readings"
        )

    avg_vib = float(np.mean(telemetry.vibration_mm_s))
    avg_temp = float(np.mean(telemetry.temperature_c))
    total_cycles = sum(telemetry.door_cycles)
    current_hours = max(telemetry.operating_hours) if telemetry.operating_hours else 0
    total_brakes = sum(telemetry.brake_actuations) if telemetry.brake_actuations else 0

    components = []
    for comp_type, model in MODELS.items():
        result = model.predict_rul(current_hours, avg_vib, avg_temp, total_cycles)
        risk = classify_risk(result["rul_percent"], result["risk_score"])
        recs = generate_recommendations(
            comp_type, risk, result["rul_percent"], avg_vib, avg_temp
        )
        components.append(
            ComponentPrediction(
                component_type=comp_type,
                remaining_useful_life_percent=result["rul_percent"],
                risk_level=risk,
                risk_score=result["risk_score"],
                predicted_failure_date=result["predicted_failure_date"],
                confidence=result["confidence"],
                recommendations=recs,
            )
        )

    overall_health = (
        sum(c.remaining_useful_life_percent for c in components) / len(components)
        if components
        else 100
    )
    risk_priority = ["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    overall_risk = min(
        (c.risk_level for c in components),
        key=lambda r: risk_priority.index(r),
    )

    return PredictionResponse(
        elevator_id=elevator_id,
        overall_health=round(overall_health, 1),
        overall_risk=overall_risk,
        components=components,
        model_version="sklearn-degradation-v1.0",
        analyzed_at=datetime.now().isoformat(),
    )


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "elevator-pulse-predictive", "version": "1.0.0"}
