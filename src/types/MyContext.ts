import type { Context, SessionFlavor } from 'grammy'
import { SessionData } from './SessionData'
import { hydrateFiles, FileFlavor } from '@grammyjs/files';
import { I18nContext } from '@grammyjs/i18n';

export type MyContext = Context & FileFlavor<Context> & SessionFlavor<SessionData> & {
  readonly i18n: I18nContext;
  readonly menu: any;
}
