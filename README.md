\# Recipe Explorer



An interactive dashboard that compares 49 cuisines across 2,218 Allrecipes dishes

(time, calories, rating, publication date). Frontend: vanilla JavaScript + D3.js.

Backend: Python + Flask.



\- \*\*Live site:\*\* https://gitfsustudent.github.io/recipe-explorer/

\- \*\*Live API:\*\* https://recipe-explorer-2nkr.onrender.com/api/health



> The API runs on Render's free tier, which sleeps after about 15 minutes of

> inactivity. The first load after a quiet period can take 30 to 60 seconds.

> Open the live API link above first to wake it up.



\## Run it locally



Requirements: Python 3.11 or newer and a web browser. No environment variables

are needed. The backend uses port 8000 and the frontend uses port 5173.



\### 1. Start the backend (terminal 1)



```

cd backend

python -m venv .venv

```



Activate the virtual environment:



\- Windows (PowerShell): `.venv\\Scripts\\Activate.ps1`

\- Windows (Command Prompt): `.venv\\Scripts\\activate.bat`

\- macOS / Linux: `source .venv/bin/activate`



Then install and run:



```

pip install -r requirements.txt

flask --app app run --port 8000

```



`gunicorn` in requirements.txt is only used by the Render deployment. If it fails

to install on Windows, run `pip install flask flask-cors pandas` instead.



Check it works: http://127.0.0.1:8000/api/health should show `{"rows":2218,"status":"ok"}`.



\### 2. Start the frontend (terminal 2, from the repository root)



```

python -m http.server 5173

```



Open http://127.0.0.1:5173. The page uses the local backend automatically when it

is opened from `localhost` or `127.0.0.1`, and the Render backend otherwise. The

address is set in one constant, `API\_BASE`, at the top of `js/script.js`.



On Windows, `py` works in place of `python` in every command above.



\## API endpoints



| Endpoint | Returns |

|---|---|

| `GET /api/health` | status and row count |

| `GET /api/recipes` | all recipes (without ingredients) |

| `GET /api/recipes/<id>` | one recipe with its ingredient list |

| `GET /api/cuisines/summary` | per-cuisine medians and counts; optional `from`, `to` (YYYY-MM), `max\_time`, `max\_cal` |



\## Data



\- \*\*Source:\*\* the `cuisines` table of the R package `tastyR` (version 0.1.0, CRAN),

&#x20; license CC0. The recipes were scraped from Allrecipes.

\- `backend/data/cuisines.csv` is the raw export. `backend/clean.py` produces

&#x20; `recipes\_clean.csv` and `ingredients.csv`, which the server loads at startup.

&#x20; Both cleaned files are committed, so you do not need to re-run the cleaning.

\- To rebuild: `cd backend`, `pip install pandas`, `python clean.py`.

\- To re-export the raw table, in R: `install.packages("tastyR")`,

&#x20; `library(tastyR)`, `data(cuisines)`, then

&#x20; `write.csv(cuisines, "cuisines.csv", row.names = FALSE)`.



\## Project layout



```

index.html, css/styles.css, js/script.js   frontend (served as static files)

backend/app.py                             Flask API

backend/clean.py                           data cleaning

backend/data/                              raw and cleaned CSV files

backend/requirements.txt

```

