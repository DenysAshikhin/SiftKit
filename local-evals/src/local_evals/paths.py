"""Filesystem roots. The package is installed editable, so these resolve inside the repository."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = PROJECT_ROOT / "fixtures"
REPO_ROOT = PROJECT_ROOT.parent
