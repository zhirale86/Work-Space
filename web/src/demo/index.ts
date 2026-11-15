/**
 * Точка входа демонстрационной сборки (VITE_DEMO=1): сервер в памяти браузера вместо сети,
 * hash-маршрутизация (страница открывается с file://), вход выбором сотрудника.
 */
import { createHashRouter } from 'react-router-dom';
import { ROUTER_FUTURE, buildRoutes } from '../App';
import { setTransport } from '../api/client';
import { layoutSlots } from '../layout/AppLayout';
import { loadOrSeed } from './control';
import { demoTransport } from './transport';
import { DemoLoginPage, DemoRoot, DemoTopbarBadge } from './ui';
import './demo.css';

export function startDemo() {
  setTransport(demoTransport);
  loadOrSeed();
  layoutSlots.topbarExtra = DemoTopbarBadge;
  return createHashRouter(buildRoutes({ Root: DemoRoot, Login: DemoLoginPage }), { future: ROUTER_FUTURE });
}
