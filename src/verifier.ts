import { Engine, Step } from './engine';
import { join } from 'path';
import { compare } from 'semver';
import {
  compareManifests,
  getManifestFromUri,
  getManifestFromFile,
} from './utils';
import { parse as parseUrl } from 'url';

export class Verifier extends Engine<VerifyProgress> {
  private nodeVersion = '';
  private npmVersion = '';
  async verify(packageDescriptor: string): Promise<boolean> {
    const { scope, packageName, version } = this.splitPackageDescriptor(
      packageDescriptor,
    );
    this.progress = createProgress();
    this.hasFailed = false;
    this.hasPrinted = false;

    this.nodeVersion = await this.exec('node --version');
    this.npmVersion = await this.exec('npm --version');

    const {
      resolvedVersion,
      repoUrl,
      gitHead,
      shasum,
      tarballUri,
    } = await this.registry(packageName, version, scope);
    if (this.hasFailed) return false;

    let cleanupDir: string;
    try {
      const { tempDir, refspec } = await this.checkout(
        repoUrl,
        gitHead,
        resolvedVersion,
      );
      cleanupDir = tempDir;
      if (this.hasFailed) return false;

      const { outputFile } = await this.pack(tempDir);
      if (this.hasFailed) return false;

      await this.compare(tarballUri, tempDir, outputFile);
      if (this.hasFailed) return false;

      return true;
    } finally {
      if (cleanupDir) this.exec(`rm -rf ${cleanupDir}`);
    }
  }

  private splitPackageDescriptor(
    packageDescriptor: string,
  ): { scope?: string; packageName: string; version: string } {
    if (packageDescriptor.startsWith('@')) {
      const scopeSplit = packageDescriptor.split('/');
      const packageSplit = scopeSplit[1].split('@');
      return {
        scope: scopeSplit[0],
        packageName: packageSplit[0],
        version: packageSplit[1],
      };
    } else {
      let packageSplit = packageDescriptor.split('@');
      return { packageName: packageSplit[0], version: packageSplit[1] };
    }
  }

  private async registry(
    packageName: string,
    version: string,
    scope?: string,
  ): Promise<{
    resolvedVersion?: string;
    repoUrl?: string;
    shasum?: string;
    gitHead?: string;
    tarballUri?: string;
  }> {
    this.updateProgress('registry', 'working');

    // Get package info
    let info: any;
    try {
      const path =
        scope != undefined ? `${scope}/${packageName}` : `${packageName}`;
      info = await this.get(`https://registry.npmjs.com/${path}`);
    } catch (err) {
      this.updateProgress(
        'registry',
        'fail',
        'Error fetching package data from registry',
      );
      return {};
    }

    // Resolve package version
    const resolvedVersion =
      (info['dist-tags'] && info['dist-tags'][version || 'latest']) || version;
    if (!resolvedVersion) {
      this.updateProgress(
        'registry',
        'fail',
        `Cannot resolve version ${version}`,
      );
      return {};
    }

    // Find version info
    const versionInfo = !!info.versions && info.versions[resolvedVersion];
    if (!versionInfo) {
      this.updateProgress(
        'registry',
        'fail',
        `Cannot find info for version ${resolvedVersion} <<<<`,
      );
      return {};
    }

    this.updateProgress('registry', 'pass');
    this.updateProgress('repo', 'working');

    // Find repository info
    if (!versionInfo.repository) {
      this.updateProgress(
        'repo',
        'fail',
        `Repository is not specified for version ${resolvedVersion}`,
      );
      return {};
    }

    // Check repository type
    if (versionInfo.repository.type !== 'git') {
      this.updateProgress(
        'repo',
        'fail',
        `Non-git (${
          versionInfo.repository.type
        }) repository specified for version ${resolvedVersion}`,
      );
      return {};
    }

    // Check repository URL
    if (!versionInfo.repository.url) {
      this.updateProgress(
        'repo',
        'fail',
        `Repository URL is not specified for version ${resolvedVersion}`,
      );
      return {};
    }

    const url = parseUrl(versionInfo.repository.url);
    const repoUrl = `https://${url.host}${url.path}`;

    this.updateProgress('repo', 'pass');
    this.updateProgress('gitHead', 'working');

    // Check for gitHead
    if (!versionInfo.gitHead) {
      this.updateProgress(
        'gitHead',
        'warn',
        `GitHead is not specified for version ${resolvedVersion}`,
      );
    }

    this.updateProgress('gitHead', 'pass');

    const shasum =
      versionInfo['_shasum'] || (versionInfo.dist && versionInfo.dist.shasum);

    const tarballUri = versionInfo.dist && versionInfo.dist.tarball;

    return { resolvedVersion, repoUrl, shasum, tarballUri };
  }

  private async checkout(
    repoUrl: string,
    gitHead: string,
    resolvedVersion: string,
  ): Promise<{ tempDir?: string; refspec?: string }> {
    this.updateProgress('checkout', 'working');
    const cwd = process.cwd();
    let tempDir = '';

    // Create temp directory
    try {
      tempDir = await this.createTemp();
    } catch (err) {
      this.updateProgress('checkout', 'fail', 'Error creating temp directory');
      return {};
    }

    process.chdir(tempDir);

    // git init
    try {
      await this.exec('git init');
    } catch (err) {
      this.updateProgress(
        'checkout',
        'fail',
        'Error initializing git repo in temp directory',
      );
      process.chdir(cwd);
      return { tempDir };
    }

    // add remote
    try {
      await this.exec(`git remote add origin "${repoUrl}"`);
    } catch (err) {
      this.updateProgress(
        'checkout',
        'fail',
        'Error initializing git repo in temp directory',
      );
      process.chdir(cwd);
      return { tempDir };
    }

    // fetch from remote
    let refspec: string;
    if (gitHead) {
      // Try by gitHead
      try {
        await this.exec(`git fetch --depth 1 origin ${gitHead}`);
        refspec = gitHead;
      } catch (err) {
        this.updateProgress(
          'checkout',
          'fail',
          `Unable fetch commit from remote (${gitHead.substring(0, 7)})`,
        );
        process.chdir(cwd);
        return { tempDir };
      }
    } else {
      // Try by v-prefixed version tag
      try {
        await this.exec(`git fetch --depth 1 origin tags/v${resolvedVersion}`);
        refspec = `tags/v${resolvedVersion}`;
      } catch {
        // Try by non-prefixed version tag
        try {
          await this.exec(`git fetch --depth 1 origin tags/${resolvedVersion}`);
          refspec = `tags/${resolvedVersion}`;
        } catch (err) {
          this.updateProgress(
            'checkout',
            'fail',
            `Unable fetch tag from remote (tags/${resolvedVersion} or tags/v${resolvedVersion})`,
          );
          process.chdir(cwd);
          return { tempDir };
        }
      }
    }

    // checkout fetch head
    try {
      await this.exec('git checkout FETCH_HEAD');
    } catch (err) {
      this.updateProgress('checkout', 'fail', 'Unable to checkout FETCH_HEAD');
      process.chdir(cwd);
      return { tempDir, refspec };
    }

    process.chdir(cwd);
    this.updateProgress('checkout', 'pass');
    return { tempDir, refspec };
  }

  private async pack(tempDir: string): Promise<{ outputFile?: string }> {
    this.updateProgress('pack', 'working');

    const cwd = process.cwd();
    process.chdir(tempDir);

    // npm pack
    let stdout: string = null;
    let failedWithoutDependencies = false;
    try {
      stdout = await this.exec(`npm pack --unsafe-perm`);
      this.updateProgress('install', 'skipped');
    } catch (err) {
      failedWithoutDependencies = true;
    }

    if (failedWithoutDependencies) {
      // install dependencies
      try {
        this.updateProgress('pack', 'pending', 'Waiting for dependencies');
        this.updateProgress('install', 'working');
        await this.npmci();
        this.updateProgress('install', 'pass');
      } catch (err) {
        this.updateProgress(
          'install',
          'fail',
          `Error installing dependencies: ${err.message}`,
        );
        process.chdir(cwd);
        return {};
      }

      // npm pack (again)
      try {
        this.updateProgress('pack', 'working');
        stdout = await this.exec(`npm pack --unsafe-perm`);
      } catch (err) {
        this.updateProgress(
          'pack',
          'fail',
          'Error creating package from remote files' + err,
        );
        process.chdir(cwd);
        return {};
      }
    }

    this.updateProgress('pack', 'pass');
    process.chdir(cwd);
    return {
      outputFile: stdout
        .trim()
        .split('\n')
        .reverse()[0]
        .trim(),
    };
  }

  private async compare(
    tarballUri: string,
    tempDir: string,
    outputFile: string,
  ): Promise<void> {
    this.updateProgress('compare', 'working');

    const [generatedManifest, publishedManifest] = await Promise.all([
      getManifestFromFile(join(tempDir, outputFile)),
      getManifestFromUri(tarballUri),
    ]);

    try {
      const diff = compareManifests(generatedManifest, publishedManifest);
      this.trace(JSON.stringify(diff, null, 2));

      if (!diff.added.length && !diff.modified.length && !diff.removed.length) {
        this.updateProgress('compare', 'pass');
      } else {
        this.updateProgress(
          'compare',
          'fail',
          `${diff.added.length} files added, ${
            diff.modified.length
          } files modified, and ${diff.removed.length} files removed.`,
        );
      }
    } catch (err) {
      this.updateProgress('compare', 'fail', `${err}`);
    }
  }

  private async npmci(): Promise<void> {
    if (compare(this.npmVersion, '5.7.0') < 0) {
      await this.exec('cipm');
    } else {
      await this.exec('npm ci');
    }
  }
}

function createProgress(): VerifyProgress {
  return {
    registry: {
      status: 'pending',
      title: 'Fetch package data from registry',
    },
    repo: {
      status: 'pending',
      title: 'Version contains repository URL',
    },
    gitHead: {
      status: 'pending',
      title: 'Version contains gitHead',
    },
    checkout: {
      status: 'pending',
      title: 'Shallow checkout',
    },
    install: {
      status: 'pending',
      title: 'Install npm packages',
    },
    pack: {
      status: 'pending',
      title: 'Create package',
    },
    compare: {
      status: 'pending',
      title: 'Compare package contents',
    },
  };
}

export type VerifyProgress = {
  registry: Step;
  repo: Step;
  gitHead: Step;
  checkout: Step;
  install: Step;
  pack: Step;
  compare: Step;
};
