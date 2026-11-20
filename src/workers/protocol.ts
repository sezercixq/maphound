import type { MapAnalysisRequest, MapAnalysisResult } from '@/core/analyze';
import type { ScriptScanRequest, ScriptScanResult } from '@/core/scan-job';

export type WorkerRequest =
  | { id: number; type: 'ping'; text: string }
  | { id: number; type: 'scan'; blobKey: string }
  | { id: number; type: 'analyze-map'; request: MapAnalysisRequest }
  | { id: number; type: 'scan-script'; request: ScriptScanRequest };

export type WorkerResult =
  | { type: 'ping'; echo: string }
  | { type: 'scan'; bytes: number; sha256: string }
  | { type: 'analyze-map'; result: MapAnalysisResult }
  | { type: 'scan-script'; result: ScriptScanResult };

export type WorkerResponse =
  | { id: number; ok: true; result: WorkerResult }
  | { id: number; ok: false; error: string };
