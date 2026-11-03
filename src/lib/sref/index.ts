/**
 * SREF Module
 * Style Reference system (--sref) for ComfyUI.
 * 
 * Exports:
 * - Parser: Parse --sref, --sw, --lora parameters from prompts
 * - Workflow Injector: Add style nodes to ComfyUI workflows
 * - API Client: Frontend utilities for style management APIs
 * - Types: TypeScript interfaces for SREF data structures
 */

// Parser exports
export {
  parseExtendedPrompt,
  formatSREF,
  formatLoRA,
  generateRandomStyleCode,
  resolveRandomSREFs,
  getSREFValue,
} from "./srefParser";

export type {
  SREFItem,
  SREFParams,
  LoRAItem,
  LoRAParams,
  ExtendedParseResult,
} from "./srefParser";

// Workflow injector exports
export {
  injectSREFNodes,
  injectLoRANodes,
  injectStyleParams,
  insertTriggers,
  convertStyleWeight,
  serializeSREFMetadata,
  serializeLoRAMetadata,
} from "./workflowInjector";

// API client exports
export {
  listStyleCodes,
  saveStyleCode,
  deleteStyleCode,
  listLoRAs,
  getRandomLoRA,
  saveLoRAShortcode,
  deleteLoRAShortcode,
  updateLoRAShortcode,
  exportStyleLibrary,
  downloadStyleLibraryExport,
  importStyleLibrary,
  importStyleLibraryFromFile,
  getStylePreview,
  requestStylePreview,
  checkPreviewJob,
  listTrainingBackends,
  startTrainingJob,
  listTrainingJobs,
  getTrainingJob,
  cancelTrainingJob,
  deployTrainingJob,
  isValidStyleCode,
  parseStyleCodeInput,
} from "./apiClient";

export type {
  StyleCodeEntry,
  LoRAShortcodeEntry,
  StyleCodesListResponse,
  LoRAsListResponse,
  ImportResult,
  PreviewJob,
  TrainingBackend,
  TrainingBackendName,
  TrainingDataset,
  StartTrainingJobRequest,
  TrainingJobStartResponse,
  TrainingJobSummary,
  TrainingJobDetail,
  TrainingDeployResult,
} from "./apiClient";

// Default export with all functions
import srefParser from "./srefParser";
import workflowInjector from "./workflowInjector";
import apiClient from "./apiClient";

export default {
  ...srefParser,
  ...workflowInjector,
  ...apiClient,
};
