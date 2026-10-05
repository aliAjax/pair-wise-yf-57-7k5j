import { createContext, useContext, type ReactNode } from 'react';

const messages = {
  title: '野外巡护坐标对账',
  sync: '回驻地同步',
  review: '负责人复核',
  save: '保存观察并对账归线'
};
const I18nContext = createContext(messages);
export function I18nProvider({ children }: { children: ReactNode }) { return <I18nContext.Provider value={messages}>{children}</I18nContext.Provider>; }
export const useI18n = () => useContext(I18nContext);
