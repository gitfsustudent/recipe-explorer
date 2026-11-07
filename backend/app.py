import json
import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # lets the browser frontend call this API from another origin

# Load once at startup. to_json writes missing values as null (JSON has no NaN).
df = pd.read_csv("data/recipes_clean.csv")
records = json.loads(df.to_json(orient="records"))
by_id = {r["id"]: r for r in records}

# Ingredients are display-only and bulky, so they are served one recipe at a time.
ing = pd.read_csv("data/ingredients.csv").fillna("")
ingredients_by_id = dict(zip(ing["id"], ing["ingredients"]))

# metric name used by the frontend -> column in the CSV
SUMMARY_COLS = {"total_time": "total_time", "calories": "calories", "rating": "avg_rating"}


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "rows": len(records)})


@app.get("/api/recipes")
def recipes():
    return jsonify(records)


@app.get("/api/recipes/<rid>")
def recipe_detail(rid):
    r = by_id.get(rid)
    if r is None:
        return jsonify({"error": "not found"}), 404
    return jsonify({**r, "ingredients": ingredients_by_id.get(rid, "")})


@app.get("/api/cuisines/summary")
def cuisines_summary():
    # optional filters: month range ("YYYY-MM" sorts correctly as text) and upper limits
    d = df
    start = request.args.get("from")
    end = request.args.get("to")
    max_time = request.args.get("max_time", type=float)
    max_cal = request.args.get("max_cal", type=float)
    if start:
        d = d[d["month"] >= start]
    if end:
        d = d[d["month"] <= end]
    if max_time is not None:
        d = d[d["total_time"] <= max_time]  # recipes with no recorded time are excluded
    if max_cal is not None:
        d = d[d["calories"] <= max_cal]  # recipes with no recorded calories are excluded

    out = []
    for (cuisine, region), g in d.groupby(["cuisine", "region"]):
        row = {"cuisine": cuisine, "region": region, "n": int(len(g))}
        for key, col in SUMMARY_COLS.items():
            vals = g[col].dropna()
            row[key] = {
                "median": round(float(vals.median()), 2) if len(vals) else None,
                "n": int(len(vals)),
            }
        out.append(row)
    return jsonify(out)