import { useEffect } from 'react';
import CF from './lib/core.js';
import { useCF } from './lib/useCF.js';
import Workspace from './pages/Workspace.jsx';
import Voices from './pages/Voices.jsx';
import Menu from './components/Menu.jsx';
import Settings from './components/Settings.jsx';
import ExportModal from './components/ExportModal.jsx';
import AgentCursor from './components/AgentCursor.jsx';
import { LivePanel, LiveList } from './components/LiveCall.jsx';

/* Two layouts: the editor (#/studio, and #/agents over the same canvas) and the voice library page (#/voices). */
export default function App() {
  useCF();
  const view = CF.ui.view;
  const page = view === 'voices';

  useEffect(() => {
    const b = document.body.classList;
    b.toggle('page-home', page); // a scrolling page instead of the full-screen canvas
    b.toggle('chat-open', !page && CF.ui.chatOpen);
    b.toggle('view-agents', view === 'agents');
  });
  useEffect(() => { if (page) window.scrollTo(0, 0); }, [page]);

  const t = CF.ui.toast;
  return (
    <>
      {page ? <Voices /> : <Workspace view={view} />}
      <Menu />
      {CF.ui.settingsOpen && <Settings />}
      {CF.ui.exportOpen && !page && <ExportModal />}
      {t && <div key={t.id} className="toast" role="status">{t.text}</div>}
      <LiveList />
      <LivePanel />
      <AgentCursor />
    </>
  );
}
