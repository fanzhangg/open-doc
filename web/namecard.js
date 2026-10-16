// Name cards: hovering a name, an @name in the doc or in a comment, a
// comment's author or a face in the header, pops up who it is, as hovering
// a mention does in a shared doc. The card is the one the header opens (see
// agent.js): view only for a name on the page, a click making it editable;
// editable at once for a face in the header.
//
// Names opt in with data-mention (and data-mention-kind). An @name opens its
// card after a short pause; data-namecard="instant" (the header's faces)
// opens it with no pause, and their own click keeps it open;
// data-namecard="click" (a comment's author) also opens it editable on a
// click. A card opened by hovering stays while the pointer moves onto it and
// goes away when the pointer leaves both, on a click elsewhere, on scroll or
// on Escape.

const OPEN_MS = 350;
const CLOSE_MS = 200;

/**
 * @param {{ card: HTMLElement, peek: (name: HTMLElement) => boolean,
 *           pin: (name: HTMLElement) => void, unpeek: () => void }} options
 *   peek: show the card of the hovered name (false when it cannot now);
 *   pin: show it editable, to stay; unpeek: hide the card a hover opened.
 */
export function createNameCards({ card, peek, pin, unpeek }) {
  let target = null; // the name the card is for, or is about to be for
  let openTimer;
  let closeTimer;

  document.addEventListener('mouseover', (event) => {
    if (card.contains(event.target)) return clearTimeout(closeTimer);
    const chip = event.target.closest?.('[data-mention]');
    if (!chip) return later();
    clearTimeout(closeTimer);
    if (chip === target) return;
    clearTimeout(openTimer);
    target = chip;
    // From one name to the next, the card follows at once.
    const wait = card.hidden && chip.dataset.namecard !== 'instant' ? OPEN_MS : 0;
    openTimer = setTimeout(() => chip.isConnected && peek(chip), wait);
  });
  document.addEventListener('mousedown', (event) => {
    if (card.contains(event.target)) return;
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    const chip = event.target.closest?.('[data-mention]');
    target = chip; // the hover does not bring it straight back
    if (chip?.dataset.namecard === 'click') pin(chip);
    else if (chip?.dataset.namecard !== 'instant') unpeek(); // the header's faces open it on their click
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') unpeek();
  });
  window.addEventListener('scroll', (event) => {
    if (!card.contains(event.target)) unpeek();
  }, true);
  window.addEventListener('resize', () => unpeek());

  function later() {
    clearTimeout(openTimer);
    if (card.hidden) {
      target = null;
      return;
    }
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      target = null;
      unpeek();
    }, CLOSE_MS);
  }
}
