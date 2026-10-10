import path from 'node:path';

import { exportPresentation, exportWarnings } from '../../modules/exports/index.js';

export async function projectExportRoutes(context) {
  const {
    id,
    route,
    req,
    res,
    url,
    root,
    library,
    ai,
    username,
    origin,
    trustProxy,
    transcriber,
    exportState,
  } = context;
  const exportRoute = /^\/export\/(pdf|pptx|html)$/.exec(route);
  if (exportRoute && req.method === 'POST') {
    if (exportState.exporting)
      throw Object.assign(new Error('Экспорт уже выполняется. Дождитесь завершения.'), {
        status: 409,
      });
    exportState.exporting = true;
    try {
      const format = exportRoute[1],
        project = await library.get(id),
        warnings = exportWarnings(project, format),
        buffer = await exportPresentation({
          root,
          project,
          assetRoot: path.join(library.directory(id), 'assets'),
          format,
        });
      if (warnings.length)
        res.setHeader('X-Presentation-Warnings', encodeURIComponent(warnings.join(' ')));
      res.setHeader(
        'Content-Type',
        format === 'pdf'
          ? 'application/pdf'
          : format === 'html'
            ? 'text/html; charset=utf-8'
            : 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      );
      res.setHeader('Content-Disposition', `attachment; filename="presentation.${format}"`);
      res.end(buffer);
    } finally {
      exportState.exporting = false;
    }
    return true;
  }

  return false;
}
