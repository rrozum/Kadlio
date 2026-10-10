import { mountPreviewFrame } from './preview-frame.js';
import { themePreviewDocument } from '../../shared/presentation/theme-preview.js';
export { themePreviewDocument } from '../../shared/presentation/theme-preview.js';

export function mountThemePreview(container, theme, context = {}) {
  return mountPreviewFrame(container, {
    title: 'Тема: ' + theme.title,
    html: themePreviewDocument(theme, context),
  });
}
