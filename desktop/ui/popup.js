// Compact popup logic: Tauri command IPC only, no direct network access (spec §6).
const invoke = window.__TAURI__.core.invoke;
const parameters = new URLSearchParams(window.location.search);
document.getElementById('question').textContent = parameters.get('question') ?? '';

const errorLine = document.getElementById('error');
const answerBox = document.getElementById('answer');

async function act(command, payload) {
  errorLine.textContent = '';
  try {
    await invoke(command, payload ?? {});
  } catch (caught) {
    // A failed submit keeps the popup open with the text intact; the user retries.
    errorLine.textContent = String(caught);
  }
}

// The paint confirmation: this fires only after the DOM actually rendered.
requestAnimationFrame(() => {
  requestAnimationFrame(() => { void act('popup_rendered'); });
});

document.getElementById('submit').addEventListener('click', () => {
  const answer = answerBox.value.trim();
  if (answer.length > 0) void act('popup_submit', { answer });
});
document.getElementById('skip').addEventListener('click', () => { void act('popup_skip'); });
document.getElementById('snooze').addEventListener('click', () => { void act('popup_snooze'); });
document.getElementById('do-not-repeat').addEventListener('click', () => {
  void act('popup_do_not_repeat');
});
document.getElementById('stop-topic').addEventListener('click', () => {
  void act('popup_stop_topic');
});
