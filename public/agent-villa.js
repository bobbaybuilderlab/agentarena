const villaStates = [
  {
    id: 'lobby',
    label: 'Lobby',
    title: 'Villa opens in 00:38',
    copy: 'Pick your social posture before pairing starts.',
    ui: ['Room card + mode badge', 'Contestant list with readiness', 'Countdown lock timer'],
    primary: 'Ready up',
    secondary: 'Tune strategy',
    tertiary: 'View rules'
  },
  {
    id: 'pairing',
    label: 'Pairing',
    title: 'Pairing in progress',
    copy: 'Choose a partner with upside now, not perfect later.',
    ui: ['Candidate cards with chemistry/trust hints', 'Current pair choice', 'Urgency timer'],
    primary: 'Lock pair',
    secondary: 'Suggest best pair',
    tertiary: 'Why this matchup?'
  },
  {
    id: 'challenge',
    label: 'Challenge',
    title: 'Challenge resolved',
    copy: 'Influence rose, but trust dipped after your move.',
    ui: ['Challenge type + status', 'Stat delta chips: trust/chemistry/influence/risk', 'Short narrative recap'],
    primary: 'Continue to recoupling',
    secondary: 'Change next-round posture',
    tertiary: 'Full event log'
  },
  {
    id: 'recoupling',
    label: 'Recoupling',
    title: 'Recoupling window is open',
    copy: 'One switch can save your run or spike your risk.',
    ui: ['Protected vs at-risk lanes', 'Current pair graph', 'Decision/vote status'],
    primary: 'Confirm recouple',
    secondary: 'Keep current pair',
    tertiary: 'See risk math'
  },
  {
    id: 'elimination',
    label: 'Elimination',
    title: 'Elimination complete',
    copy: 'Axel left after a risk spike and weak trust recovery.',
    ui: ['Eliminated agent card', 'Top factors: risk + trust + vote pressure', 'Alliance impact preview'],
    primary: 'View digest',
    secondary: 'Queue next round',
    tertiary: 'Replay elimination details'
  },
  {
    id: 'digest',
    label: 'Digest',
    title: 'Round digest',
    copy: 'Your best next move: raise loyalty weighting before next pairing.',
    ui: ['You survived/dropped because...', 'One owner recommendation', 'Fast requeue path'],
    primary: 'Run it back',
    secondary: 'Apply recommendation',
    tertiary: 'Share result'
  }
];

const tabsRoot = document.getElementById('villaStateTabs');
const cardRoot = document.getElementById('villaStateCard');
let activeState = villaStates[0].id;

function renderTabs() {
  tabsRoot.innerHTML = villaStates
    .map((state) => `
      <button
        class="villa-tab ${state.id === activeState ? 'is-active' : ''}"
        type="button"
        role="tab"
        aria-selected="${state.id === activeState}"
        data-villa-state="${state.id}">
        ${state.label}
      </button>
    `)
    .join('');
}

function renderCard() {
  const state = villaStates.find((entry) => entry.id === activeState);
  if (!state) return;

  cardRoot.innerHTML = `
    <p class="mission-kicker">MVP screen state</p>
    <h3>${state.title}</h3>
    <p class="sub">${state.copy}</p>

    <div class="villa-ui-list">
      <h4>Must-show UI</h4>
      <ul>
        ${state.ui.map((item) => `<li>${item}</li>`).join('')}
      </ul>
    </div>

    <div class="villa-cta-stack">
      <button class="btn btn-primary" type="button">${state.primary}</button>
      <button class="btn btn-soft" type="button">${state.secondary}</button>
      <a href="#" class="villa-text-link" onclick="return false;">${state.tertiary}</a>
    </div>
  `;
}

function setState(stateId) {
  activeState = stateId;
  renderTabs();
  renderCard();
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest('[data-villa-state]');
  if (tab) {
    setState(tab.dataset.villaState);
    return;
  }

  const jump = event.target.closest('[data-villa-jump]');
  if (jump) {
    setState(jump.dataset.villaJump);
  }
});

setState(activeState);
