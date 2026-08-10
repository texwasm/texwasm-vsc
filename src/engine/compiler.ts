import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type * as vscode from "vscode";
import { resolveAssetsDir, resolveBiberDir } from "../cache/storage";
import { getIncludeExtraBundle } from "../config/settings";
import { appendLog } from "../output/outputChannel";
import type {
	CompileOptions,
	CompileResult,
	WorkerCompileResponse,
	WorkerDocstripResponse,
	WorkerInitResponse,
	WorkerMessage,
	WorkerResponse,
} from "./types";

export class Compiler {
	private context: vscode.ExtensionContext;
	private worker: Worker | undefined;
	private initialized = false;

	constructor(context: vscode.ExtensionContext) {
		this.context = context;
	}

	get extensionContext(): vscode.ExtensionContext {
		return this.context;
	}

	private getWorkerPath(): string {
		return path.join(this.context.extensionPath, "dist", "wasmWorker.js");
	}

	get assetsDir(): string {
		return resolveAssetsDir(this.context);
	}

	get biberAssetsDir(): string {
		return resolveBiberDir(this.context);
	}

	assetsReady(): boolean {
		const dir = this.assetsDir;
		const includeExtra = getIncludeExtraBundle();
		const required = ["busytex.js", "busytex.wasm", "texlive-basic.js", "texlive-basic.data"];
		if (includeExtra) {
			required.push("texlive-extra.js", "texlive-extra.data");
		}
		return required.every((f) => fs.existsSync(path.join(dir, f)));
	}

	private async withWorker<T>(fn: (worker: Worker) => Promise<T>): Promise<T> {
		if (!this.worker) {
			const workerPath = this.getWorkerPath();
			if (!fs.existsSync(workerPath)) {
				throw new Error(
					`Worker not found at ${workerPath}. Run 'npm run compile' first.`,
				);
			}
			this.worker = new Worker(workerPath);
			this.worker.on("error", (err) => {
				const message = err instanceof Error ? err.message : String(err);
				appendLog(`[TeXWASM] Worker error: ${message}`);
			});
			this.worker.on("exit", (code) => {
				appendLog(`[TeXWASM] Worker exited with code ${code}`);
				if (this.worker) {
					this.worker = undefined;
					this.initialized = false;
				}
			});
			this.worker.on("message", (msg: WorkerResponse) => {
				if (msg.type === "log") {
					appendLog(`[TeXWASM] ${msg.message}`);
				}
			});
		}
		return fn(this.worker);
	}

	private sendAndWait(
		worker: Worker,
		msg: WorkerMessage,
	): Promise<WorkerResponse> {
		return new Promise((resolve, reject) => {
			const requestId = msg.requestId ?? Math.random();
			(msg as unknown as Record<string, unknown>).requestId = requestId;

const handler = (response: WorkerResponse) => {
		if ("requestId" in response && response.requestId === requestId) {
			worker.off("message", handler);
			resolve(response);
		}
	};
			worker.on("message", handler);
			worker.postMessage(msg);

			setTimeout(() => {
				worker.off("message", handler);
				reject(new Error("Request timed out"));
			}, 120000);
		});
	}

	async init(): Promise<void> {
		if (this.initialized) return;

		await this.withWorker(async (worker) => {
		const result = (await this.sendAndWait(worker, {
			type: "init",
			requestId: 0,
			assetsDir: this.assetsDir,
			biberAssetsDir: this.biberAssetsDir,
			includeExtraBundle: getIncludeExtraBundle(),
		})) as WorkerInitResponse;
			if (!result.success) {
				throw new Error(result.errorMessage || "Engine initialization failed");
			}
			this.initialized = true;
		});
	}

	async compile(options: CompileOptions): Promise<CompileResult> {
		await this.init();

		return this.withWorker(async (worker) => {
			const result = (await this.sendAndWait(worker, {
				type: "compile",
				requestId: Math.random(),
				sourceContent: options.sourceContent,
				texName: path.basename(options.sourcePath),
				engine: options.engine,
				bibtexEnabled: options.bibtexEnabled,
				makeindexEnabled: options.makeindexEnabled,
				biblioBackend: options.biblioBackend,
				compilationPasses: options.compilationPasses,
				includeExtraBundle: options.includeExtraBundle,
				projectFiles: options.projectFiles.map((f) => ({
					path: f.path,
					content: f.content,
				})),
				extraFiles: options.extraFiles,
			})) as WorkerCompileResponse;

			if (!result.success) {
				return {
					success: false,
					logContent: result.logContent,
					errorMessage: result.errorMessage || "Compilation failed",
				};
			}

			const pdfName = path
				.basename(options.sourcePath)
				.replace(/\.tex$/i, ".pdf");
			const outputPdfPath = options.outputDirectory
				? path.resolve(
						path.dirname(options.sourcePath),
						options.outputDirectory,
						pdfName,
					)
				: path.resolve(path.dirname(options.sourcePath), pdfName);

			const pdfDir = path.dirname(outputPdfPath);
			if (!fs.existsSync(pdfDir)) {
				fs.mkdirSync(pdfDir, { recursive: true });
			}

			const logName = path
				.basename(options.sourcePath)
				.replace(/\.tex$/i, ".log");
			const logPath = path.resolve(path.dirname(options.sourcePath), logName);

			if (result.pdfBytes) {
				fs.writeFileSync(outputPdfPath, Buffer.from(result.pdfBytes));
			}
			if (result.logContent) {
				fs.writeFileSync(logPath, result.logContent, "utf-8");
			}

			if (result.auxFiles) {
				const sourceDir = path.dirname(options.sourcePath);
				const baseName = path.basename(options.sourcePath, ".tex");
				for (const [ext, data] of Object.entries(result.auxFiles)) {
					const auxPath = path.resolve(sourceDir, baseName + ext);
					fs.writeFileSync(auxPath, Buffer.from(data));
				}
			}

			return {
				success: true,
				pdfPath: outputPdfPath,
				logPath,
				logContent: result.logContent,
			};
		});
	}

	/**
	 * Run docstrip (.ins) files through pdflatex in the WASM engine to generate
	 * .sty/.cls files for CTAN source packages that ship no ready-to-use ones.
	 * Returns only the files generated by the docstrip run.
	 */
	async docstrip(
		files: { path: string; content: Uint8Array }[],
	): Promise<{ path: string; content: Uint8Array }[]> {
		await this.init();

		return this.withWorker(async (worker) => {
			const result = (await this.sendAndWait(worker, {
				type: "docstrip",
				requestId: Math.random(),
				files,
			})) as WorkerDocstripResponse;

			if (!result.success) {
				throw new Error(result.errorMessage || "Docstrip failed");
			}
			return result.files ?? [];
		});
	}

	cancel(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = undefined;
			this.initialized = false;
		}
	}
}
