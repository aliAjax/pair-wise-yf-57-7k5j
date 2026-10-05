import { configureStore } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import patrolReducer from './patrolSlice';
import { storage } from '../platform/storage';
import type { PatrolState } from '../domain/types';

export const patrolApi = createApi({
  reducerPath: 'patrolApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    connection: builder.query<{ online: boolean }, void>({
      queryFn: () => ({ data: { online: true } })
    })
  })
});
export const { useConnectionQuery } = patrolApi;

export const store = configureStore({
  reducer: { patrol: patrolReducer, [patrolApi.reducerPath]: patrolApi.reducer },
  middleware: (getDefault) => getDefault().concat(patrolApi.middleware)
});

if (typeof window !== 'undefined') {
  store.subscribe(() => storage.set('yf57-coordinate-reconcile-state', store.getState().patrol));
}

export type RootState = ReturnType<typeof store.getState>;
export type { PatrolState };
