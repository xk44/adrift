/**
 * Turn a training request into the exact commands and config files a local
 * trainer runs. Pure (no fs, no spawn) so the argv can be snapshot-tested.
 *
 * Ported from StyleVault's trainers.py: musubi-tuner Krea 2 runs three
 * commands (cache latents, cache text-encoder outputs, accelerate-launched
 * training); ai-toolkit runs `run.py <config.yaml>`. Only argv arrays and
 * config text are produced; no trainer code is copied.
 */
import path from "node:path";
import type { TrainerBackendId } from "./schema";

export interface PlanParams {
  steps?: number;
  lr?: number;
  rank?: number;
  resolution?: number;
  triggerWord?: string;
  /** With or without the leading dot; default ".txt". */
  captionExt?: string;
  blocksToSwap?: number;
  excludeShared?: boolean;
  lrWarmupSteps?: number | string;
}

export interface PlanModels {
  dit?: string;
  textEncoder?: string;
  vae?: string;
  model?: string;
  assistantLora?: string;
}

export interface PlanInput {
  backend: TrainerBackendId;
  family: string;
  repoPath: string;
  pythonBin: string;
  /** Per-job folder: configs, caches and output go under it. */
  jobDir: string;
  datasetDir: string;
  runName: string;
  params: PlanParams;
  models: PlanModels;
  platform?: NodeJS.Platform;
}

export interface PlanCommand {
  name: string;
  argv: string[];
}

export interface TrainPlan {
  backend: TrainerBackendId;
  family: string;
  cwd: string;
  commands: PlanCommand[];
  files: { path: string; content: string }[];
  outputDir: string;
}

export class PlanError extends Error {}

export const DEFAULT_ASSISTANT_LORA =
  "ostris/krea2_turbo_training_adapter/krea2_turbo_training_adapter_v1.safetensors";

const KREA2_EXCLUDE_SHARED =
  'exclude_patterns=["first","last\\..*","tmlp\\..*","txtmlp\\..*","tproj\\..*","txtfusion\\..*"]';

/** musubi asserts blocks_to_swap <= num_blocks - 2 (Krea 2 has 28). */
const KREA2_MAX_BLOCKS_TO_SWAP = 26;

/** JSON strings are valid TOML basic strings and YAML double-quoted scalars. */
const q = (s: string) => JSON.stringify(s);

function num(v: number): string {
  return Number.isFinite(v) ? String(v) : "0";
}

function captionExt(p: PlanParams): { dot: string; nodot: string } {
  const raw = (p.captionExt ?? ".txt").trim() || ".txt";
  const dot = raw.startsWith(".") ? raw : `.${raw}`;
  return { dot, nodot: dot.slice(1) };
}

function need(value: string | undefined, label: string): string {
  if (!value) throw new PlanError(`${label} is not set (Settings → Training).`);
  return value;
}

function accelerateConfig(mixedPrecision: "bf16" | "no"): string {
  return [
    "compute_environment: LOCAL_MACHINE",
    "debug: false",
    "distributed_type: 'NO'",
    "downcast_bf16: 'no'",
    "enable_cpu_affinity: false",
    "machine_rank: 0",
    "main_training_function: main",
    `mixed_precision: ${mixedPrecision}`,
    "num_machines: 1",
    "num_processes: 1",
    "rdzv_backend: static",
    "same_network: true",
    "use_cpu: false",
    "",
  ].join("\n");
}

function musubiDatasetToml(opts: {
  resolution: number;
  captionExt: string;
  datasetDir: string;
  cacheDir: string;
}): string {
  return [
    "[general]",
    `resolution = [${opts.resolution}, ${opts.resolution}]`,
    `caption_extension = ${q(opts.captionExt)}`,
    "batch_size = 1",
    "enable_bucket = true",
    "bucket_no_upscale = false",
    "",
    "[[datasets]]",
    `image_directory = ${q(opts.datasetDir)}`,
    `cache_directory = ${q(opts.cacheDir)}`,
    "num_repeats = 1",
    "",
  ].join("\n");
}

function musubiKrea2(input: PlanInput): TrainPlan {
  const { params: p, repoPath, pythonBin, jobDir } = input;
  const mac = (input.platform ?? process.platform) === "darwin";
  const dit = need(input.models.dit, "Krea 2 DiT checkpoint");
  const te = need(input.models.textEncoder, "Krea 2 text encoder");
  const vae = need(input.models.vae, "Krea 2 VAE");
  const outputDir = path.join(jobDir, "output");
  const datasetConfig = path.join(jobDir, "dataset.toml");
  const accConfig = path.join(jobDir, "accelerate.yaml");
  const resolution = p.resolution ?? 1024;
  const rank = String(p.rank ?? 16);
  const mixed = mac ? "no" : "bf16";
  const script = (name: string) =>
    path.join(repoPath, "src", "musubi_tuner", name);
  const device = mac ? ["--device", "mps"] : [];

  const train: string[] = [
    pythonBin,
    "-m",
    "accelerate.commands.launch",
    "--config_file",
    accConfig,
    "--num_cpu_threads_per_process",
    "1",
    "--mixed_precision",
    mixed,
    script("krea2_train_network.py"),
    "--dit",
    dit,
    "--vae",
    vae,
    "--dataset_config",
    datasetConfig,
    "--sdpa",
    "--mixed_precision",
    mixed,
    "--timestep_sampling",
    "shift",
    "--weighting_scheme",
    "none",
    "--discrete_flow_shift",
    "2.5",
    "--optimizer_type",
    mac ? "adamw" : "adamw8bit",
    "--learning_rate",
    String(p.lr ?? "5e-5"),
    "--gradient_checkpointing",
    "--max_grad_norm",
    "1.0",
    "--lr_scheduler",
    "constant_with_warmup",
    "--lr_warmup_steps",
    String(p.lrWarmupSteps ?? "0.05"),
    "--max_data_loader_n_workers",
    "2",
    "--persistent_data_loader_workers",
    "--network_module",
    "networks.lora_krea2",
    ...(p.excludeShared === false
      ? []
      : ["--network_args", KREA2_EXCLUDE_SHARED]),
    "--network_dim",
    rank,
    "--network_alpha",
    rank,
    "--max_train_steps",
    String(p.steps ?? 1500),
    "--save_every_n_steps",
    "500",
    "--seed",
    "42",
    "--output_dir",
    outputDir,
    "--output_name",
    input.runName,
  ];
  if (!mac)
    train.push(
      "--fp8_base",
      "--fp8_scaled",
      "--blocks_to_swap",
      String(Math.min(p.blocksToSwap ?? 20, KREA2_MAX_BLOCKS_TO_SWAP)),
    );

  return {
    backend: "musubi-tuner",
    family: "krea2",
    cwd: repoPath,
    outputDir,
    files: [
      {
        path: datasetConfig,
        content: musubiDatasetToml({
          resolution,
          captionExt: captionExt(p).dot,
          datasetDir: input.datasetDir,
          cacheDir: path.join(jobDir, "cache"),
        }),
      },
      { path: accConfig, content: accelerateConfig(mixed) },
    ],
    commands: [
      {
        name: "cache latents",
        argv: [
          pythonBin,
          script("krea2_cache_latents.py"),
          "--dataset_config",
          datasetConfig,
          "--vae",
          vae,
          ...device,
        ],
      },
      {
        name: "cache text encoder",
        argv: [
          pythonBin,
          script("krea2_cache_text_encoder_outputs.py"),
          "--dataset_config",
          datasetConfig,
          "--text_encoder",
          te,
          "--batch_size",
          "1",
          ...device,
        ],
      },
      { name: "train", argv: train },
    ],
  };
}

function aitkModelBlock(input: PlanInput): string[] {
  if (input.family === "krea2") {
    return [
      "      model:",
      `        name_or_path: ${q(need(input.models.model, "Krea 2 Turbo checkpoint"))}`,
      "        arch: krea2",
      "        quantize: true",
      "        quantize_te: true",
      "        low_vram: true",
      `        assistant_lora_path: ${q(input.models.assistantLora || DEFAULT_ASSISTANT_LORA)}`,
    ];
  }
  if (input.family === "moss_image") {
    return [
      "      model:",
      `        name_or_path: ${q(need(input.models.model, "MOSS-Image checkpoint"))}`,
      "        arch: moss_image",
      "        quantize: false",
      "        quantize_te: false",
      "        low_vram: true",
      "        model_kwargs:",
      `          text_encoder_path: ${q(need(input.models.textEncoder, "MOSS-Image text encoder"))}`,
      `          vae_path: ${q(need(input.models.vae, "MOSS-Image VAE"))}`,
    ];
  }
  throw new PlanError(`ai-toolkit has no config for ${input.family}.`);
}

function aiToolkit(input: PlanInput): TrainPlan {
  const { params: p, jobDir } = input;
  const mac = (input.platform ?? process.platform) === "darwin";
  const outputDir = path.join(jobDir, "output");
  const configPath = path.join(jobDir, "ai-toolkit.yaml");
  const resolution = p.resolution ?? 1024;
  const rank = p.rank ?? 16;
  const trigger = p.triggerWord ?? "";
  const moss = input.family === "moss_image";
  const yaml = [
    "---",
    "job: extension",
    "config:",
    `  name: ${q(input.runName)}`,
    "  process:",
    "    - type: sd_trainer",
    `      training_folder: ${q(outputDir)}`,
    `      device: ${mac ? "mps" : "cuda:0"}`,
    `      trigger_word: ${q(trigger)}`,
    "      network:",
    "        type: lora",
    `        linear: ${rank}`,
    `        linear_alpha: ${rank}`,
    "      save:",
    `        dtype: ${moss ? "float16" : "bf16"}`,
    "        save_every: 500",
    "        max_step_saves_to_keep: 2",
    "      datasets:",
    `        - folder_path: ${q(input.datasetDir)}`,
    `          caption_ext: ${q(captionExt(p).nodot)}`,
    "          caption_dropout_rate: 0.05",
    "          shuffle_tokens: false",
    "          cache_latents_to_disk: true",
    `          resolution: [${resolution}]`,
    "      train:",
    "        batch_size: 1",
    "        cache_text_embeddings: true",
    `        steps: ${p.steps ?? 1500}`,
    "        gradient_accumulation: 1",
    "        train_unet: true",
    "        train_text_encoder: false",
    "        gradient_checkpointing: true",
    "        noise_scheduler: flowmatch",
    "        optimizer: adamw8bit",
    `        lr: ${num(p.lr ?? 1e-4)}`,
    "        dtype: bf16",
    "        skip_first_sample: true",
    "        disable_sampling: true",
    ...aitkModelBlock(input),
    "meta:",
    `  name: ${q(input.runName)}`,
    `  model_family: ${q(input.family)}`,
    "",
  ].join("\n");
  return {
    backend: "ai-toolkit",
    family: input.family,
    cwd: input.repoPath,
    outputDir,
    files: [{ path: configPath, content: yaml }],
    commands: [
      {
        name: "train",
        argv: [
          input.pythonBin,
          path.join(input.repoPath, "run.py"),
          configPath,
        ],
      },
    ],
  };
}

export function buildTrainPlan(input: PlanInput): TrainPlan {
  if (input.backend === "musubi-tuner") {
    if (input.family !== "krea2")
      throw new PlanError(`musubi-tuner has no recipe for ${input.family}.`);
    return musubiKrea2(input);
  }
  return aiToolkit(input);
}
