import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ServerContext } from './server-types.js';

export type RouteMethod = 'DELETE' | 'GET' | 'POST' | 'PUT';

export type RouteMatch = {
  pathname: string;
  captures: string[];
};

export interface RouteEndpoint {
  handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    match: RouteMatch,
  ): Promise<void> | void;
}

export type RouteDefinition = {
  method: RouteMethod;
  path: string | RegExp;
  endpoint: RouteEndpoint;
};

type MatchedRoute = {
  definition: RouteDefinition;
  match: RouteMatch;
};

function normalizeMethod(method: string | undefined): string {
  return String(method || 'GET').toUpperCase();
}

function matchRoutePath(path: string | RegExp, pathname: string): RouteMatch | null {
  if (typeof path === 'string') {
    return path === pathname ? { pathname, captures: [] } : null;
  }
  const match = path.exec(pathname);
  if (!match) {
    return null;
  }
  return {
    pathname,
    captures: match.slice(1),
  };
}

export class RouteTable {
  constructor(private readonly routes: readonly RouteDefinition[]) {}

  hasPath(pathname: string): boolean {
    return this.routes.some((route) => matchRoutePath(route.path, pathname) !== null);
  }

  match(method: string | undefined, pathname: string): MatchedRoute | null {
    const requestMethod = normalizeMethod(method);
    for (const definition of this.routes) {
      if (definition.method !== requestMethod) {
        continue;
      }
      const match = matchRoutePath(definition.path, pathname);
      if (match) {
        return { definition, match };
      }
    }
    return null;
  }

  async handle(
    ctx: ServerContext,
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> {
    const route = this.match(req.method, pathname);
    if (!route) {
      return false;
    }
    await route.definition.endpoint.handle(ctx, req, res, route.match);
    return true;
  }
}
