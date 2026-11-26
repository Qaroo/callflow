import CF from '../lib/core.js';
import { Icon } from './Icon.jsx';

/* header for the scrolling pages (the voice library) */
export default function TopNav() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const v = CF.ui.view;
  return (
    <nav className="home-nav">
      <div className="hn-inner">
        <a className="hn-brand" href="#/studio">
          <span className="app-icon"><Icon name="flow" /></span>
          <span>Call Flow Studio</span>
        </a>
        <div className="hn-links">
          <a href="#/studio">תסריטים</a>
          <a href="#/agents">סוכנים</a>
          <a href="#/voices" className={v === 'voices' ? 'on' : ''}>ספריית קול</a>
        </div>
        <span className="tb-spacer" />
        <button className="tb-btn icon-only" type="button" title="הגדרות" aria-label="הגדרות" onClick={() => CF.openSettings(true)}><Icon name="gear" /></button>
        <button className="tb-btn icon-only" type="button" title={dark ? 'מצב בהיר' : 'מצב כהה'} aria-label="החלף מצב בהיר או כהה" onClick={() => CF.toggleTheme()}><Icon name={dark ? 'sun' : 'moon'} /></button>
      </div>
    </nav>
  );
}
