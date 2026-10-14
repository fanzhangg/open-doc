// The start window: New doc, Open, and the recent docs.

const desktop = window.opendocDesktop;
const list = document.querySelector('ul');
const empty = document.querySelector('.empty');
const mod = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+';

document.querySelector('[data-action="new"]').addEventListener('click', () => desktop.newDoc().catch(() => {}));
document.querySelector('[data-action="open"]').addEventListener('click', () => desktop.open().catch(() => {}));
document.querySelector('.keys').textContent = `${mod}N new doc · ${mod}O open`;

async function showRecent() {
  const recent = await desktop.recent();
  list.replaceChildren(...recent.map(({ name, folder }, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = `${folder}`;
    const title = document.createElement('span');
    title.className = 'name';
    title.textContent = name;
    const where = document.createElement('span');
    where.className = 'folder';
    // rtl keeps the end of a long path visible; the mark keeps it readable
    where.textContent = `‎${folder}‎`;
    button.append(title, where);
    button.addEventListener('click', () => desktop.openRecent(index).catch(() => {}));
    const item = document.createElement('li');
    item.append(button);
    return item;
  }));
  empty.hidden = recent.length > 0;
}

desktop.onRecentChanged(showRecent);
showRecent();
