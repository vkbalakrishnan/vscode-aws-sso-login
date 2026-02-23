const vscode = require('vscode');
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec, spawn } = require("child_process");
const { promisify } = require("util");

const outputChannel = vscode.window.createOutputChannel("AWS SSO Login");

const execAsync = promisify(exec);

/**
 * Parse AWS config file to extract SSO profiles
 * @returns {Object} Object with profile names as keys and profile configs as values
 */
async function parseAwsConfig() {
  try {
    const configPath = path.join(os.homedir(), ".aws", "config");

    if (!fs.existsSync(configPath)) {
      return {};
    }

    const configContent = fs.readFileSync(configPath, "utf8");
    const lines = configContent.split("\n");

    const sections = {};
    let currentSection = null;
    let currentSectionType = null;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and comments
      if (!trimmedLine || trimmedLine.startsWith("#")) {
        continue;
      }

      // Check for section definitions
      const profileMatch = trimmedLine.match(/^\[profile\s+(.+)\]$/);
      const ssoSessionMatch = trimmedLine.match(/^\[sso-session\s+(.+)\]$/);
      const genericSectionMatch = trimmedLine.match(/^\[(.+)\]$/);

      if (profileMatch) {
        currentSection = profileMatch[1];
        currentSectionType = "profile";
        sections[`profile ${currentSection}`] = {};
        continue;
      } else if (ssoSessionMatch) {
        currentSection = ssoSessionMatch[1];
        currentSectionType = "sso-session";
        sections[`sso-session ${currentSection}`] = {};
        continue;
      } else if (genericSectionMatch && !profileMatch && !ssoSessionMatch) {
        currentSection = genericSectionMatch[1];
        currentSectionType = "other";
        sections[currentSection] = {};
        continue;
      }

      // If we're in a section, parse the key-value pairs
      if (currentSection) {
        const kvMatch = trimmedLine.match(/^(\S+)\s*=\s*(.+)$/);
        if (kvMatch) {
          const [, key, value] = kvMatch;
          sections[`${currentSectionType === "profile" ? "profile " : currentSectionType === "sso-session" ? "sso-session " : ""}${currentSection}`][key] = value;
        }
      }
    }

    // Process profiles to handle both direct SSO config and sso-session references
    const ssoProfiles = {};
    
    for (const [sectionName, config] of Object.entries(sections)) {
      // Only process profile sections
      if (!sectionName.startsWith("profile ")) {
        continue;
      }
      
      const profileName = sectionName.substring("profile ".length);
      
      // Case 1: Profile has direct SSO configuration
      if (
        config.sso_start_url &&
        config.sso_region &&
        config.sso_account_id &&
        config.sso_role_name
      ) {
        ssoProfiles[profileName] = {
          name: profileName,
          startUrl: config.sso_start_url,
          region: config.sso_region,
          accountId: config.sso_account_id,
          roleName: config.sso_role_name,
        };
      }
      // Case 2: Profile references an sso-session and has account_id and role_name
      else if (
        config.sso_session &&
        config.sso_account_id &&
        config.sso_role_name
      ) {
        const ssoSessionName = config.sso_session;
        const ssoSessionConfig = sections[`sso-session ${ssoSessionName}`];
        
        if (ssoSessionConfig && ssoSessionConfig.sso_start_url && ssoSessionConfig.sso_region) {
          ssoProfiles[profileName] = {
            name: profileName,
            startUrl: ssoSessionConfig.sso_start_url,
            region: ssoSessionConfig.sso_region,
            accountId: config.sso_account_id,
            roleName: config.sso_role_name,
          };
        }
      }
      // Case 3: Profile references another profile via source_profile
      else if (config.source_profile && config.role_arn) {
        const sourceProfileName = config.source_profile;
        // Check if the source profile is an SSO profile we've already processed
        if (ssoProfiles[sourceProfileName]) {
          // We don't add this profile to ssoProfiles as it's not directly an SSO profile
          // but we could handle it differently if needed
        }
      }
    }
    
    outputChannel.append(
      "SSO Profiles: " + JSON.stringify(ssoProfiles, null, 2)
    );

    return ssoProfiles;
  } catch (error) {
    console.error("Error parsing AWS config:", error);
    return {};
  }
}

/**
 * Get all available AWS SSO profiles
 * @returns {Array} Array of profile objects
 */
async function getAwsSsoProfiles() {
  // Get profiles from AWS config file
  const configProfiles = await parseAwsConfig();
  // Get profiles from VS Code settings
  const vscodeProfiles =
    vscode.workspace.getConfiguration("awsSsoLogin").get("profiles") || [];

  // Convert VS Code profiles to the same format as config profiles
  const vscodeProfilesMap = {};
  for (const profile of vscodeProfiles) {
    vscodeProfilesMap[profile.name] = profile;
  }

  // Merge profiles, with config profiles taking precedence
  const mergedProfiles = { ...vscodeProfilesMap, ...configProfiles };

  return Object.values(mergedProfiles);
}

/**
 * Validate that a profile name contains only safe characters
 * @param {string} name The profile name to validate
 * @returns {boolean} True if the name is valid
 */
function isValidProfileName(name) {
  return /^[a-zA-Z0-9_.-]+$/.test(name);
}

/**
 * Build environment variables with common PATH locations included
 * @returns {Object} Environment object with augmented PATH
 */
function buildEnvWithPaths() {
  const env = { ...process.env };
  const homebrewPaths = [
    "/opt/homebrew/bin",
    "/usr/local/homebrew/bin",
    "/usr/local/bin"
  ];
  const currentPath = env.PATH || "";
  const additionalPaths = homebrewPaths.filter(p => !currentPath.includes(p)).join(":");
  if (additionalPaths) {
    env.PATH = additionalPaths + ":" + currentPath;
  }
  return env;
}

/**
 * Find the AWS CLI executable path
 * @returns {Promise<String|null>} Path to AWS CLI or null if not found
 */
async function findAwsCliPath() {
  // Common installation paths for AWS CLI
  const commonPaths = [
    "aws", // Default PATH
    "/usr/local/bin/aws", // Common macOS/Linux location
    "/usr/bin/aws", // Common Linux location
    "/opt/homebrew/bin/aws", // Homebrew on Apple Silicon Macs
    "/usr/local/homebrew/bin/aws", // Homebrew on Intel Macs
    "C:\\Program Files\\Amazon\\AWSCLI\\bin\\aws.exe", // Windows default
    "C:\\Program Files (x86)\\Amazon\\AWSCLI\\bin\\aws.exe" // Windows 32-bit on 64-bit
  ];
  
  // Check each path
  for (const awsPath of commonPaths) {
    try {
      await execAsync(`"${awsPath}" --version`);
      return awsPath;
    } catch (error) {
      // Continue to next path
    }
  }
  
  return null; // AWS CLI not found
}

/**
 * Show AWS CLI installation instructions based on the operating system
 */
function showAwsCliInstallationInstructions() {
  const platform = os.platform();
  let message = "AWS CLI is not installed or not in your PATH. ";
  
  switch (platform) {
    case "darwin": // macOS
      message += "Install it using: 'brew install awscli' or download from AWS website.";
      break;
    case "win32": // Windows
      message += "Download and install from the AWS website or use 'winget install -e --id Amazon.AWSCLI'.";
      break;
    case "linux":
      message += "Install it using your package manager (e.g., 'apt install awscli' or 'yum install awscli') or download from AWS website.";
      break;
    default:
      message += "Please install AWS CLI from: https://aws.amazon.com/cli/";
  }
  
  const installOption = "Installation Instructions";
  const cancelOption = "Cancel";
  
  vscode.window.showErrorMessage(message, installOption, cancelOption).then(selection => {
    if (selection === installOption) {
      vscode.env.openExternal(vscode.Uri.parse("https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"));
    }
  });
}

/**
 * Start AWS SSO login process
 * @param {Object} profile The SSO profile
 * @returns {Promise<Boolean>} True if login successful
 */
async function startSsoLogin(profile) {
  try {
    const awsPath = await findAwsCliPath();
    if (!awsPath) {
      showAwsCliInstallationInstructions();
      return false;
    }

    if (!isValidProfileName(profile.name)) {
      vscode.window.showErrorMessage(
        `Invalid profile name: "${profile.name}". Profile names must contain only letters, numbers, hyphens, underscores, and periods.`
      );
      return false;
    }

    outputChannel.appendLine(`Starting SSO login for profile: ${profile.name}`);

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `AWS SSO: ${profile.name}`,
        cancellable: true,
      },
      async (progress, cancellationToken) => {
        progress.report({ message: "Starting authentication..." });

        const env = buildEnvWithPaths();

        return new Promise((resolve, reject) => {
          const child = spawn(
            awsPath,
            ['sso', 'login', '--profile', profile.name],
            { env, stdio: ['inherit', 'pipe', 'pipe'] }
          );

          let stderr = '';
          let verificationCodeFound = false;

          cancellationToken.onCancellationRequested(() => {
            child.kill('SIGTERM');
            resolve(false);
          });

          child.stdout.on('data', (data) => {
            outputChannel.appendLine(data.toString());
          });

          child.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            outputChannel.appendLine(text);

            if (!verificationCodeFound) {
              const codeMatch = text.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
              if (codeMatch) {
                verificationCodeFound = true;
                const code = codeMatch[1];

                progress.report({
                  message: `Verification code: ${code} -- Confirm this matches your browser`
                });

                vscode.env.clipboard.writeText(code);

                vscode.window.showInformationMessage(
                  `AWS SSO verification code: ${code} (copied to clipboard)`,
                  'Copy Code'
                ).then(selection => {
                  if (selection === 'Copy Code') {
                    vscode.env.clipboard.writeText(code);
                  }
                });
              }
            }
          });

          child.on('close', (code) => {
            if (code === 0) {
              resolve(true);
            } else {
              outputChannel.appendLine(`AWS CLI exited with code ${code}`);
              const errorMsg = stderr.trim() || `AWS CLI exited with code ${code}`;
              if (errorMsg.includes("command not found") || errorMsg.includes("not recognized")) {
                showAwsCliInstallationInstructions();
              } else {
                vscode.window.showErrorMessage(`AWS SSO login failed: ${errorMsg}`);
              }
              resolve(false);
            }
          });

          child.on('error', (err) => {
            outputChannel.appendLine(`AWS SSO login error: ${err.message}`);
            if (err.message.includes("ENOENT")) {
              showAwsCliInstallationInstructions();
            } else {
              vscode.window.showErrorMessage(`AWS SSO login failed: ${err.message}`);
            }
            resolve(false);
          });
        });
      }
    );

    return result;
  } catch (error) {
    outputChannel.appendLine(`Error starting SSO login: ${error.message}`);
    vscode.window.showErrorMessage(`Error starting SSO login: ${error.message}`);
    return false;
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // Register the login command
  let loginDisposable = vscode.commands.registerCommand(
    "awsSsoLogin.login",
    async function () {
      try {
        // Get available profiles
        const profiles = await getAwsSsoProfiles();

        if (profiles.length === 0) {
          vscode.window.showErrorMessage(
            "No AWS SSO profiles found. Please configure profiles in ~/.aws/config or VS Code settings."
          );
          return;
        }
        // Show quick pick to select profile
        const profileItems = profiles.map((profile) => ({
          label: profile.name,
          description: `Account: ${profile.accountId}, Role: ${profile.roleName}`,
          profile,
        }));

        const selectedItem = await vscode.window.showQuickPick(profileItems, {
          placeHolder: "Select an AWS SSO profile",
          ignoreFocusOut: true,
        });

        if (!selectedItem) {
          return; // User cancelled
        }

        const profile = selectedItem.profile;

        // AWS CLI handles token caching internally - if a valid token
        // exists, it completes instantly without opening a browser
        const loginSuccess = await startSsoLogin(profile);
        if (!loginSuccess) {
          return;
        }

        vscode.window.showInformationMessage(
          `AWS SSO login successful for profile: ${profile.name}`
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `AWS SSO login failed: ${error.message}`
        );
      }
    }
  );

  context.subscriptions.push(loginDisposable);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    parseAwsConfig  // Export for testing
};
