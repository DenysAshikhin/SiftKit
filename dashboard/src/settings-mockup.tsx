import { SETTINGS_MOCKUP_SECTIONS, type SettingsMockupField } from './settings-mockup-data';

type MockupHelpProps = {
  label: string;
  text: string;
};

type MockupFieldProps = {
  field: SettingsMockupField;
};

function MockupHelp({ label, text }: MockupHelpProps) {
  return (
    <span className="settings-mockup-help">
      <button type="button" className="settings-mockup-help-trigger" aria-label={`Explain ${label}`}>
        ?
      </button>
      <span className="settings-mockup-help-popover" role="note">
        {text}
      </span>
    </span>
  );
}

function MockupField({ field }: MockupFieldProps) {
  const className = `settings-mockup-field settings-mockup-field-${field.layout} settings-mockup-kind-${field.kind}`;
  return (
    <article className={className}>
      <div className="settings-mockup-field-label-row">
        <strong>{field.label}</strong>
        {field.description ? <MockupHelp label={field.label} text={field.description} /> : null}
      </div>
      {field.kind === 'toggle' ? (
        <div className="settings-mockup-toggle">
          <span className={field.value ? 'settings-mockup-toggle-track on' : 'settings-mockup-toggle-track'}>
            <span className="settings-mockup-toggle-thumb" />
          </span>
          <span>{field.value ? 'Enabled' : 'Disabled'}</span>
        </div>
      ) : field.kind === 'textarea' ? (
        <pre className="settings-mockup-textarea">{field.value}</pre>
      ) : (
        <span className="settings-mockup-value">{field.value}</span>
      )}
    </article>
  );
}

export function SettingsMockupPage() {
  return (
    <div className="app-shell">
      <header className="topbar settings-mockup-topbar">
        <div>
          <h1>SiftKit Local Dashboard</h1>
          <p>Visual settings mockup with real field labels, grouped sections, and styled hover help.</p>
        </div>
        <a className="settings-mockup-backlink" href="/">
          Back To Dashboard
        </a>
      </header>

      <section className="settings-mockup-layout">
        <aside className="settings-mockup-rail">
          <div className="settings-mockup-rail-card">
            <span className="settings-mockup-rail-kicker">Route</span>
            <h2>/mockup</h2>
            <p className="hint">Visual-only layout experiment. No live config loads or saves happen on this page.</p>
          </div>
          <nav className="settings-mockup-rail-nav" aria-label="Mockup sections">
            {SETTINGS_MOCKUP_SECTIONS.map((section) => (
              <a key={section.id} className="settings-mockup-rail-link" href={`#${section.id}`}>
                <span className="settings-mockup-icon-badge">{section.icon}</span>
                <span>
                  <strong>{section.title}</strong>
                  <span>{section.summary}</span>
                </span>
              </a>
            ))}
          </nav>
        </aside>

        <section className="settings-mockup-main">
          <div className="settings-mockup-hero">
            <div>
              <span className="settings-mockup-rail-kicker">Settings Workspace</span>
              <h2>Grouped runtime configuration</h2>
              <p className="hint">The layout uses a left rail for orientation, denser field grids for short values, and help popovers for tradeoff-heavy controls.</p>
            </div>
            <div className="settings-mockup-actions" aria-hidden="true">
              <button type="button" disabled>
                Reload
              </button>
              <button type="button" disabled className="settings-mockup-save">
                Save Settings
              </button>
            </div>
          </div>

          {SETTINGS_MOCKUP_SECTIONS.map((section) => (
            <section key={section.id} id={section.id} className="settings-mockup-section">
              <header className="settings-mockup-section-header">
                <div>
                  <span className="settings-mockup-icon-badge">{section.icon}</span>
                  <div>
                    <h3>{section.title}</h3>
                    <p className="hint">{section.summary}</p>
                  </div>
                </div>
              </header>
              <div className="settings-mockup-field-grid">
                {section.fields.map((field) => (
                  <MockupField key={field.label} field={field} />
                ))}
              </div>
            </section>
          ))}
        </section>
      </section>
    </div>
  );
}
