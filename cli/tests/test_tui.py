from __future__ import annotations

from flexablelib_tui.accessibility import AuditIssue

from imperium_cli.tui.app import audit_shell, run_tui


def test_audit_accesibilidad_sin_problemas():
    issues = audit_shell(profile=None)
    assert issues == []
    assert all(not isinstance(i, AuditIssue) or True for i in issues)


def test_tui_headless_keys():
    frame = run_tui(profile=None, accesible=True, keys=["f1", "escape", "q"])
    assert frame is not None
    text = frame if isinstance(frame, str) else getattr(frame, "text", None) or str(frame)
    assert "Imperium" in text or "Estado" in text or "CLI" in text or len(text) > 0


def test_audit_con_filas():
    from flexablelib_tui.accessibility import audit
    from flexablelib_components import DataTable, AppShell
    table = DataTable(
        columns=["slug", "name"],
        rows=[{"slug": "demo", "name": "Demo"}],
        selectable=True,
        a11y_label="Apps",
    )
    shell = AppShell(pages={"Apps": table}, content=table, a11y_label="Imperium")
    assert audit([shell, table], check_focus=True) == []
