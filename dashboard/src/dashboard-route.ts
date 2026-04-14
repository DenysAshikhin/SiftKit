export type DashboardView = 'app' | 'mockup';

export function getDashboardView(pathname: string): DashboardView {
  return pathname === '/mockup' ? 'mockup' : 'app';
}
