import type { MapAnalysisRequest, MapAnalysisResult } from '@/core/analyze';

export type WorkerRequest =
  | { id: number; type: 'ping'; text: string }
  | { id: number; type: 'scan'; blobKey: string }
  | { id: number; type: 'analyze-map'; request: MapAnalysisRequest };

export type WorkerResult =
  | { type: 'ping'; echo: string }
  | { type: 'scan'; bytes: number; sha256: string }
  | { type: 'analyze-map'; result: MapAnalysisResult };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: string };
