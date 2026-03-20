# Quick Start Guide - Bundled Artifact Format

## 🎯 For Your Specific Use Case

Your model was saved using the **bundled artifact format**:
- Single `.pkl` file containing: model + scaler + feature names + version
- Saved with `joblib`
- Created by `save_model_artifacts()` function

## 📦 What You Have

```
production_models_JobAgnostic/
├── resume_detector_1.0.0.pkl          # ← Bundled artifact (use this!)
└── resume_detector_params_1.0.0.json  # ← Parameters (for inspection)
```

## 🚀 Quick Start (2 Steps!)

### Step 1: Prepare Test Data

Your test CSV needs:
- All the feature columns from training
- `label` column (0 or 1)
- Optional: `relevancy` or other grouping column

```csv
sim_title_skill,sim_all,dist_title,dist_skill,...,label,relevancy
0.85,0.72,0.15,0.23,...,1,applied
0.45,0.38,0.67,0.72,...,0,notRelevant
```

### Step 2: Run Evaluation

```bash
python evaluate_bundled_model.py \
    --artifact production_models_JobAgnostic/resume_detector_1.0.0.pkl \
    --data your_test_data.csv \
    --output results/
```

That's it! The script automatically:
- ✅ Loads model, scaler, and feature names from the artifact
- ✅ Validates your data has the right features
- ✅ Scales features using the bundled scaler
- ✅ Computes AUC and all metrics
- ✅ Generates ROC curves and confusion matrices
- ✅ Saves results to JSON and CSV

## 📊 What You Get

After running evaluation, check the `results/` directory:

```
results/
├── results_test.json              # All metrics
├── predictions_test.csv           # Predictions for each sample
├── roc_curve_test.png            # ROC visualization
└── confusion_matrix_test.png     # Confusion matrix
```

### results_test.json
```json
{
  "split": "test",
  "version": "1.0.0",
  "n_samples": 5000,
  "auc": 0.7779,
  "accuracy": 0.7129,
  "precision": 0.7234,
  "recall": 0.6644,
  "f1": 0.6926,
  "threshold": 0.5713
}
```

### predictions_test.csv
```csv
y_true,y_proba,y_pred
1,0.823,1
0,0.234,0
1,0.654,1
```

## 🔧 Advanced Usage

### Subgroup Analysis

```bash
python evaluate_bundled_model.py \
    --artifact production_models_JobAgnostic/resume_detector_1.0.0.pkl \
    --data test.csv \
    --subgroup relevancy \
    --output results/
```

Output includes breakdown by relevancy type:
```
SUBGROUP SUMMARY
================================================================
  subgroup  n_samples    auc  accuracy  precision  recall
   applied       1500  0.772     0.707      0.723   0.664
notRelevant       2000  0.778     0.713      0.712   0.664
perfect_match     1500  0.776     0.707      0.720   0.666
```

### Custom Threshold

```bash
python evaluate_bundled_model.py \
    --artifact production_models_JobAgnostic/resume_detector_1.0.0.pkl \
    --data test.csv \
    --threshold 0.6 \
    --output results/
```

Use custom thresholds when:
- You need higher precision (fewer false positives) → use 0.6-0.7
- You need higher recall (catch more positives) → use 0.3-0.4

### Disable Plots (Faster)

```bash
python evaluate_bundled_model.py \
    --artifact production_models_JobAgnostic/resume_detector_1.0.0.pkl \
    --data test.csv \
    --no-plots \
    --output results/
```

## 💻 Python Usage

```python
from evaluate_bundled_model import evaluate_dataset
from pathlib import Path

results = evaluate_dataset(
    artifact_path=Path("production_models_JobAgnostic/resume_detector_1.0.0.pkl"),
    data_path=Path("test.csv"),
    label_col="label",
    threshold=None,  # Use optimal threshold
    output_dir=Path("results/"),
    create_plots=True,
    split_name="test"
)

print(f"AUC: {results['auc']:.4f}")
print(f"Accuracy: {results['accuracy']:.4f}")
```

## 📋 Feature Requirements

The bundled artifact contains the feature list, so you don't need to specify it!

The script will:
1. Load feature names from the artifact
2. Check your data has those exact columns
3. Tell you if anything is missing

If you get an error like "Missing features", check:
```python
import joblib
artifact = joblib.load("production_models_JobAgnostic/resume_detector_1.0.0.pkl")
print("Required features:", artifact['features'])
```

## 🆚 Which Script to Use?

### Use `evaluate_bundled_model.py` (RECOMMENDED) when:
- ✅ Your model was saved with `save_model_artifacts()`
- ✅ You have a single `.pkl` file with everything bundled
- ✅ You want the simplest workflow

### Use `evaluate_new_dataset.py` when:
- Model and scaler are in separate files
- You need to manually specify feature names
- You're working with different model formats

## 📈 Expected Performance

Based on your training notebook:

| Split | Relevancy | AUC | Accuracy |
|-------|-----------|-----|----------|
| Test | applied | 0.772 | 0.707 |
| Test | notRelevant | 0.778 | 0.713 |
| Test | perfect_match | 0.776 | 0.707 |

Your new data should achieve similar metrics if:
- Features are computed the same way
- Class distribution is similar
- No major data drift

## ⚠️ Troubleshooting

### "Missing features in dataset"
→ Your test data is missing some feature columns
→ Check: `artifact['features']` vs your CSV columns

### "Label column not found"
→ Add `--label your_label_column_name` if it's not called "label"

### Low AUC compared to training
→ Check for data drift (feature distributions changed)
→ Verify labels are correct
→ Use `--subgroup` to find which groups perform poorly

### "FileNotFoundError"
→ Check your paths are correct
→ Use absolute paths if needed

## 🎓 Understanding Metrics

- **AUC (0.75-0.80)**: Good discrimination between classes
- **Accuracy**: % of correct predictions
- **Precision**: When model says "positive", how often is it right?
- **Recall (TPR)**: What % of actual positives did we catch?
- **FPR**: What % of negatives were incorrectly flagged?
- **FNR**: What % of positives did we miss?

## 💡 Pro Tips

1. **Start small**: Test with 100 rows first to verify everything works
2. **Check feature values**: Make sure they're in reasonable ranges
3. **Compare distributions**: Training vs test feature statistics
4. **Use subgroups**: Find which segments need improvement
5. **Try thresholds**: 0.5 is default, but adjust for your use case

## 📚 Full Documentation

For more details, see:
- `README.md` - Comprehensive guide
- `evaluate_new_dataset.py` - Alternative for non-bundled models
- `example_usage.py` - Working code examples

---

**Need help?** The script is verbose and will tell you exactly what it's doing at each step!