import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import './styles.css';
import { brand } from './brand';
import { getSession, setSession } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Properties from './pages/Properties';
import PropertyDetail from './pages/PropertyDetail';
import Leads from './pages/Leads';
import Pipeline from './pages/Pipeline';
import Agenda from './pages/Agenda';
import Tasks from './pages/Tasks';
import Automations from './pages/Automations';
import Rentals from './pages/Rentals';
import Security from './pages/Security';
import Payments from './pages/Payments';
import AcceptInvite from './pages/AcceptInvite';
import { PortalHome, PortalProperties, PortalPayouts } from './pages/Portal';
import { RenterHome, RenterPayments, RenterContract } from './pages/RenterPortal';
import { RenterMaintenance, PortalMaintenance } from './pages/Maintenance';

/** Página inicial por perfil. Lê a sessão a cada renderização (e não uma vez, na montagem das rotas). */
function Home() {
  const role = getSession()?.user.role;
  if (role === 'landlord') return <Navigate to="/portal" replace />;
  if (role === 'renter') return <Navigate to="/inquilino" replace />;
  return <Dashboard />;
}

function Shell() {
  const s = getSession();
  const nav = useNavigate();
  if (!s) return <Navigate to="/login" replace />;
  const logout = () => { setSession(null); nav('/login'); };
  // Proprietário (usuário externo): área própria, sem nenhum menu da operação.
  if (s.user.role === 'landlord') {
    return (
      <div className="shell">
        <aside className="sidebar">
          <div className="logo">{brand.name}<span>.</span></div>
          <nav className="nav" aria-label="Portal do proprietário">
            <NavLink to="/portal" end>Resumo</NavLink>
            <NavLink to="/portal/imoveis">Meus imóveis</NavLink>
            <NavLink to="/portal/repasses">Repasses e extrato</NavLink>
            <NavLink to="/portal/manutencao">Manutenção</NavLink>
            <NavLink to="/seguranca">Segurança</NavLink>
          </nav>
          <div className="foot">{s.user.name}<br /><button className="btn ghost" style={{ marginTop: 8 }} onClick={logout}>Sair</button></div>
        </aside>
        <main className="main"><Outlet /></main>
      </div>
    );
  }
  // Inquilino (usuário externo): área própria, só o contrato dele.
  if (s.user.role === 'renter') {
    return (
      <div className="shell">
        <aside className="sidebar">
          <div className="logo">{brand.name}<span>.</span></div>
          <nav className="nav" aria-label="Portal do inquilino">
            <NavLink to="/inquilino" end>Resumo</NavLink>
            <NavLink to="/inquilino/pagamentos">Pagamentos</NavLink>
            <NavLink to="/inquilino/contrato">Contrato</NavLink>
            <NavLink to="/inquilino/chamados">Chamados</NavLink>
            <NavLink to="/seguranca">Segurança</NavLink>
          </nav>
          <div className="foot">{s.user.name}<br /><button className="btn ghost" style={{ marginTop: 8 }} onClick={logout}>Sair</button></div>
        </aside>
        <main className="main"><Outlet /></main>
      </div>
    );
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="logo">{brand.name}<span>.</span></div>
        <nav className="nav" aria-label="Principal">
          <NavLink to="/" end>Visão geral</NavLink>
          <NavLink to="/crm">CRM</NavLink>
          <NavLink to="/pipeline">Pipeline</NavLink>
          <NavLink to="/imoveis">Imóveis</NavLink>
          <NavLink to="/agenda">Agenda</NavLink>
          {["owner", "manager", "finance", "broker"].includes(s.user.role) && <NavLink to="/locacao">Locação</NavLink>}
          <NavLink to="/tarefas">Tarefas</NavLink>
          {["owner", "manager", "finance"].includes(s.user.role) && <NavLink to="/pagamentos">Pagamentos</NavLink>}
          <NavLink to="/seguranca">Segurança</NavLink>
          {["owner", "manager"].includes(s.user.role) && <NavLink to="/automacoes">Automações</NavLink>}
        </nav>
        <div className="foot">
          {s.user.name}<br />
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={logout}>Sair</button>
        </div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/aceitar-convite" element={<AcceptInvite />} />
        <Route element={<Shell />}>
          <Route index element={<Home />} />
          <Route path="inquilino" element={<RenterHome />} />
          <Route path="inquilino/pagamentos" element={<RenterPayments />} />
          <Route path="inquilino/contrato" element={<RenterContract />} />
          <Route path="inquilino/chamados" element={<RenterMaintenance />} />
          <Route path="portal" element={<PortalHome />} />
          <Route path="portal/imoveis" element={<PortalProperties />} />
          <Route path="portal/repasses" element={<PortalPayouts />} />
          <Route path="portal/manutencao" element={<PortalMaintenance />} />
          <Route path="crm" element={<Leads />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="agenda" element={<Agenda />} />
          <Route path="tarefas" element={<Tasks />} />
          <Route path="seguranca" element={<Security />} />
          <Route path="pagamentos" element={<Payments />} />
          <Route path="locacao" element={<Rentals />} />
          <Route path="automacoes" element={<Automations />} />
          <Route path="imoveis" element={<Properties />} />
          <Route path="imoveis/:id" element={<PropertyDetail />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
