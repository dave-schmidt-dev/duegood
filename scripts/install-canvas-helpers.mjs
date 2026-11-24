import path from "node:path";
import { DESKTOP_INSTALL_LOCK } from "./canvas-runtime-build-identity.mjs";
import { prepareCanvasHelper } from "./prepare-canvas-helper.mjs";

/** Serialize bundle swaps through helper publication, including installs from different stages. */
export async function acquireCandidateInstallLock(files, applicationsDirectory) {
  const lock = path.join(applicationsDirectory, DESKTOP_INSTALL_LOCK);
  try {
    await files.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    throw new Error(`Another desktop installation holds ${lock}. If it was interrupted, confirm the installer has stopped before removing the empty lock directory.`, { cause: error });
  }
  const owner = await files.lstat(lock);
  return async () => {
    const current = await files.lstat(lock);
    if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) {
      throw new Error("The desktop installation lock changed ownership.");
    }
    await files.rmdir(lock);
  };
}

/** Builds and installs helpers from the source bytes bound to the staged app candidate. */
export async function installCandidateCanvasHelpers({
  candidateRoot,
  sourceCommit,
  candidateTree,
  homeDirectory,
  recoveryCheckout,
  progress = () => undefined,
  prepare = prepareCanvasHelper,
} = {}) {
  progress("building Canvas helpers from the staged app candidate");
  try {
    return await prepare({
      sourceCheckout: candidateRoot,
      sourceCommit,
      candidateTree,
      homeDirectory,
      progress,
    });
  } catch (error) {
    throw new Error(
      `Canvas helper preparation failed during ${error?.phase ?? "installation"}. Create a fresh candidate from ${recoveryCheckout} with npm run stage:tauri and retry npm run install:tauri. To repair helpers separately, run npm run canvas:prepare-helper from the checkout matching the installed app.`,
      { cause: error },
    );
  }
}
