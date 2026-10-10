import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Library } from './engine.js';
import { atomicFile } from '../storage/connectors/atomic-file.js';
import { ShareFeedback } from '../modules/sharing/feedback.js';
import { createSlideRenderer } from '../modules/previews/slides.js';
import { DocumentPreviewStore } from '../modules/previews/documents.js';
import { AuthStore } from '../modules/auth/service.js';
import { createProjectTools } from '../modules/mcp/tools.js';
import { createMcpHttpHandler } from '../modules/mcp/server.js';
import { createTranscriber } from '../modules/ai/transcription.js';
import { AIService } from '../modules/ai/service.js';

// Единственное место сборки зависимостей. HTTP, ИИ и MCP получают один движок,
// поэтому ручные изменения и инструменты используют одинаковые очереди/CAS.
export async function createApplication(root, config) {
  const {
    dataDir,
    legacyRoot,
    dataFile,
    authRequired,
    authFile,
    initialAdmin,
    publicOrigin,
    documentPreviewOptions,
    transcriptionOptions,
    aiOptions,
  } = config;
  const library = await new Library(dataDir).init({ legacyRoot, legacyFile: dataFile });
  library.feedback = new ShareFeedback(library);
  library.renderer = createSlideRenderer({ root, library });
  library.documentPreviews = new DocumentPreviewStore({ dataDir, ...documentPreviewOptions });
  const auth = authRequired
    ? new AuthStore(authFile || process.env.AUTH_DB || path.join(dataDir, 'auth.sqlite'), {
        secure: new URL(publicOrigin).protocol === 'https:',
      })
    : null;
  if (auth) {
    try {
      await auth.bootstrapOwner(initialAdmin);
    } catch (error) {
      auth.close();
      throw error;
    }
  }
  const tokenFile = path.join(dataDir, 'agent-token');
  let agentToken;
  try {
    agentToken = (await readFile(tokenFile, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    agentToken = randomBytes(32).toString('base64url');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await atomicFile(tokenFile, agentToken + '\n');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(agentToken)) throw new Error('Неверный файл токена агента.');
  const tools = createProjectTools(library),
    mcp = createMcpHttpHandler({ tools }),
    transcriber = createTranscriber(transcriptionOptions);
  let ai;
  const application = {
    library,
    engine: library,
    auth,
    agentToken,
    tools,
    mcp,
    transcriber,
    exportState: { exporting: false },
    async startAI(url) {
      ai = new AIService({
        dataDir,
        library,
        root,
        mcpUrl: url + '/api/agent-tools',
        mcpToken: agentToken,
        ...aiOptions,
      });
      await ai.ready;
      library.attachments = ai.attachments;
      library.themeAttachments = ai.themeAttachments;
      this.ai = ai;
      return ai;
    },
    close() {
      ai.close();
      library.renderer.close();
      library.documentPreviews.close();
      transcriber.close();
      auth?.close();
    },
  };
  return application;
}
