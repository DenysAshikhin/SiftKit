import { sendJson } from '../../http-utils.js';
import { AssistantNotFoundError } from '../../../assistant/errors.js';
import {
  assistantRoute, id, integerParam, sendError, sendQueryResult,
} from './helpers.js';

export const searchEndpoint = assistantRoute(({ service, res, url }) => {
  const result = service.memoryQueries.search(
    service.ownerId, url.searchParams.get('q') ?? '', integerParam(url, 'limit', 50),
  );
  sendJson(res, 200, {
    nodes: result.nodes.map((row) => ({ ...row })),
    assertions: result.assertions.map((row) => ({ ...row })),
    projections: result.projections.map((row) => ({ ...row })),
  });
});

export const listNodesEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, { items: service.memoryQueries.listNodes(service.ownerId, {
    limit: integerParam(url, 'limit', 50), offset: integerParam(url, 'offset', 0),
  }) });
});

export const neighborhoodEndpoint = assistantRoute(({ service, res, match, url }) => {
  sendQueryResult(res, service.memoryQueries.getNeighborhood(
    service.ownerId, id(match), integerParam(url, 'maxHops', 2),
  ));
});

export const getNodeEndpoint = assistantRoute(({ service, res, match }) => {
  sendQueryResult(res, service.memoryQueries.getNode(service.ownerId, id(match)));
});

export const listAssertionsEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, { items: service.memoryQueries.listAssertions(service.ownerId, {
    limit: integerParam(url, 'limit', 50), offset: integerParam(url, 'offset', 0),
  }) });
});

export const explainAssertionEndpoint = assistantRoute(({ service, res, match }) => {
  sendQueryResult(
    res, service.memoryQueries.explainAssertion(service.ownerId, id(match)),
  );
});

export const getAssertionEndpoint = assistantRoute(({ service, res, match }) => {
  sendQueryResult(res, service.memoryQueries.getAssertion(service.ownerId, id(match)));
});

export const listEvidenceEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, { items: service.memoryQueries.listEvidence(service.ownerId, {
    limit: integerParam(url, 'limit', 50), offset: integerParam(url, 'offset', 0),
  }) });
});

export const evidenceBlobEndpoint = assistantRoute(({ service, res, url }) => {
  try {
    const pixels = service.readEvidencePixels(url.searchParams.get('id') ?? '');
    // Decrypt-and-serve only: nothing on disk, nothing cacheable (spec §6).
    res.writeHead(200, {
      'Content-Type': pixels.mimeType,
      'Content-Length': pixels.bytes.byteLength,
      'Cache-Control': 'no-store',
    });
    res.end(pixels.bytes);
  } catch (error) {
    if (error instanceof AssistantNotFoundError) {
      sendError(res, 404, 'not_found', 'Evidence pixels are not available.');
    } else {
      sendError(
        res, 500, 'evidence_unreadable',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
});

export const getEvidenceEndpoint = assistantRoute(({ service, res, match }) => {
  sendQueryResult(
    res, service.memoryQueries.getEvidenceMetadata(service.ownerId, id(match)),
  );
});

export const listProjectionsEndpoint = assistantRoute(({ service, res }) => {
  sendJson(res, 200, { items: service.memoryQueries.listProjections(service.ownerId) });
});

export const historyEndpoint = assistantRoute(({ service, res, url }) => {
  sendJson(res, 200, { items: service.memoryQueries.listMemoryHistory(service.ownerId, {
    limit: integerParam(url, 'limit', 100), offset: integerParam(url, 'offset', 0),
  }) });
});
