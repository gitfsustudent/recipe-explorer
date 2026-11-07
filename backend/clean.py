import pandas as pd

REGIONS = {
    "Europe": ["Austrian","Belgian","Danish","Dutch","Finnish","French","German",
               "Greek","Italian","Norwegian","Polish","Portuguese","Russian",
               "Scandinavian","Spanish","Swedish","Swiss"],
    "Asia": ["Bangladeshi","Chinese","Filipino","Indian","Indonesian","Japanese",
             "Korean","Malaysian","Pakistani","Thai","Vietnamese"],
    "Latin America & Caribbean": ["Argentinian","Brazilian","Chilean","Colombian",
             "Cuban","Jamaican","Peruvian","Puerto Rican"],
    "North America": ["Amish and Mennonite","Cajun and Creole","Canadian",
             "Soul Food","Southern Recipes","Tex-Mex"],
    "Middle East": ["Israeli","Lebanese","Persian","Turkish"],
    "Other": ["Australian and New Zealander","South African","Jewish"],
}
cuisine_to_region = {c: r for r, cs in REGIONS.items() for c in cs}

df = pd.read_csv("data/cuisines.csv", parse_dates=["date_published"])
print("rows loaded:", len(df))

# cuisine and region (the source column is called "country", but not all are countries)
df = df.rename(columns={"country": "cuisine"})
df["region"] = df["cuisine"].map(cuisine_to_region)
unmapped = df.loc[df["region"].isna(), "cuisine"].unique()
print("unmapped cuisines:", list(unmapped))
assert len(unmapped) == 0, "fix the REGIONS dictionary"

# stable unique id from the Allrecipes URL
df["id"] = "r" + (df.index + 1).astype(str).str.zfill(4)
assert df["url"].is_unique, "urls are not unique"
assert df["id"].is_unique, "ids are not unique"

# zero times: treat as missing, not "instant"
zero_total = df["total_time"] == 0
print("total_time == 0:", zero_total.sum(),
      "| of those with prep or cook > 0:",
      (zero_total & ((df["prep_time"] > 0) | (df["cook_time"] > 0))).sum())
df.loc[zero_total, ["prep_time", "cook_time", "total_time"]] = pd.NA
print("total < prep + cook:", (df["total_time"] < df["prep_time"] + df["cook_time"]).sum())

# time columns for the timeline
df["year"] = df["date_published"].dt.year
df["month"] = df["date_published"].dt.strftime("%Y-%m")
df["date_published"] = df["date_published"].dt.strftime("%Y-%m-%d")

#ingredients are display-only: saved separately and served one recipe at a time
df[["id", "ingredients"]].to_csv("data/ingredients.csv", index=False)
df = df.drop(columns=["ingredients"])

df.to_csv("data/recipes_clean.csv", index=False)
print("rows written:", len(df), "| columns:", list(df.columns))
print(df["region"].value_counts())
print(df.isna().sum())