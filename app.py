from flask import Flask, jsonify, render_template
import requests

app = Flask(__name__)

BINANCE_EXCHANGE_INFO = "https://api.binance.com/api/v3/exchangeInfo"

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/symbols")
def symbols():
    try:
        response = requests.get(BINANCE_EXCHANGE_INFO, timeout=15)
        response.raise_for_status()
        payload = response.json()
        rows = []
        for item in payload.get("symbols", []):
            if item.get("status") != "TRADING":
                continue
            if item.get("isSpotTradingAllowed") is False:
                continue
            if item.get("quoteAsset") != "USDT":
                continue
            rows.append({
                "symbol": item["symbol"],
                "baseAsset": item["baseAsset"],
                "quoteAsset": item["quoteAsset"],
                "displayName": f"{item['baseAsset']}/{item['quoteAsset']}",
            })
        rows.sort(key=lambda x: x["displayName"])
        return jsonify({"symbols": rows})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500

if __name__ == "__main__":
    app.run(debug=False)