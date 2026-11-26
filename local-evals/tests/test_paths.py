from local_evals.paths import PROJECT_ROOT, REPO_ROOT


def test_roots_point_at_the_package_and_the_repository() -> None:
    assert (PROJECT_ROOT / "pyproject.toml").is_file()
    assert (REPO_ROOT / "package.json").is_file()
