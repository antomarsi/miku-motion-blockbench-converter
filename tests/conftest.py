from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = REPO_ROOT / "assets"


@pytest.fixture
def assets_dir() -> Path:
    """The git-ignored real-asset folder; tests using it are skipped when it's absent."""
    if not ASSETS_DIR.is_dir():
        pytest.skip("assets/ not present (real assets are never committed)")
    return ASSETS_DIR


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--update-golden", action="store_true", help="rewrite golden files from current output"
    )


@pytest.fixture
def update_golden(request: pytest.FixtureRequest) -> bool:
    return bool(request.config.getoption("--update-golden"))
