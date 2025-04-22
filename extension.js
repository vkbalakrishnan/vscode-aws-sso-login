const vscode = require('vscode');
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");
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
  console.log("Config profiles:", configProfiles);
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
 * Check if SSO token is valid for the given profile
 * @param {Object} profile The SSO profile
 * @returns {Boolean} True if token is valid, false otherwise
 */
async function isSsoTokenValid(profile) {
  try {
    const ssoClient = new SSO({
      region: profile.region,
    });

    // Try to get account list to verify token is valid
    await ssoClient.listAccounts({});
    return true;
  } catch (error) {
    console.log("SSO token validation error:", error.message);
    return false;
  }
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
 * Check if AWS CLI is installed and available
 * @returns {Promise<Boolean>} True if AWS CLI is installed
 */
async function isAwsCliInstalled() {
  const awsPath = await findAwsCliPath();
  return awsPath !== null;
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
    // Find AWS CLI path
    const awsPath = await findAwsCliPath();
    if (!awsPath) {
      showAwsCliInstallationInstructions();
      return false;
    }
    
    // Use AWS CLI to start SSO login with the full path
    const command = `"${awsPath}" sso login --profile ${profile.name}`;
    
    // Log the command being executed for debugging
    console.log(`Executing AWS CLI command: ${command}`);
    outputChannel.appendLine(`Executing AWS CLI command: ${command}`);

    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Logging in to AWS SSO profile: ${profile.name}`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: "Opening browser for authentication..." });

        try {
          // Execute with environment variables that include common PATH locations
          const env = { ...process.env };
          
          // Add Homebrew paths to PATH if not already included
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
          
          await execAsync(command, { env });
          return true;
        } catch (error) {
          console.error("AWS SSO login error:", error);
          outputChannel.appendLine(`AWS SSO login error: ${error.message}`);
          
          // Check if it's a command not found error
          if (error.message.includes("command not found") || error.message.includes("not recognized")) {
            showAwsCliInstallationInstructions();
          } else {
            vscode.window.showErrorMessage(
              `AWS SSO login failed: ${error.message}`
            );
          }
          return false;
        }
      }
    );

    return result;
  } catch (error) {
    console.error("Error starting SSO login:", error);
    vscode.window.showErrorMessage(
      `Error starting SSO login: ${error.message}`
    );
    return false;
  }
}

/**
 * Get AWS credentials for the given profile
 * @param {Object} profile The SSO profile
 * @returns {Promise<Object>} The credentials object
 */
async function getAwsCredentials(profile) {
  try {
    const ssoClient = new SSO({
      region: profile.region,
    });

    const response = await ssoClient.getRoleCredentials({
      accountId: profile.accountId,
      roleName: profile.roleName,
    });

    const credentials = response.roleCredentials;

    return {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: new Date(credentials.expiration),
    };
  } catch (error) {
    console.error("Error getting AWS credentials:", error);
    throw error;
  }
}

/**
 * Update AWS credentials file with the given credentials
 * @param {String} profileName The profile name
 * @param {Object} credentials The credentials object
 */
async function updateAwsCredentialsFile(profileName, credentials) {
  try {
    const credentialsPath = path.join(os.homedir(), ".aws", "credentials");

    // Create directory if it doesn't exist
    const awsDir = path.join(os.homedir(), ".aws");
    if (!fs.existsSync(awsDir)) {
      fs.mkdirSync(awsDir);
    }

    // Read existing credentials file or create empty content
    let content = "";
    if (fs.existsSync(credentialsPath)) {
      content = fs.readFileSync(credentialsPath, "utf8");
    }

    const lines = content.split("\n");
    const newLines = [];

    let inTargetProfile = false;
    let profileFound = false;

    // Process existing content
    for (const line of lines) {
      const trimmedLine = line.trim();

      // Check for profile definition
      const profileMatch = trimmedLine.match(/^\[(.+)\]$/);
      if (profileMatch) {
        // If we were in the target profile, we're now exiting it
        if (inTargetProfile) {
          inTargetProfile = false;
        }

        // Check if this is the target profile
        if (profileMatch[1] === profileName) {
          profileFound = true;
          inTargetProfile = true;

          // Add profile header
          newLines.push(`[${profileName}]`);

          // Add credentials
          newLines.push(`aws_access_key_id = ${credentials.accessKeyId}`);
          newLines.push(
            `aws_secret_access_key = ${credentials.secretAccessKey}`
          );
          newLines.push(`aws_session_token = ${credentials.sessionToken}`);

          // Skip to next line to avoid adding the profile header again
          continue;
        }
      }

      // Skip lines in the target profile
      if (inTargetProfile) {
        // Skip key-value pairs in the target profile
        if (trimmedLine.match(/^\S+\s*=\s*.+$/)) {
          continue;
        }
      }

      // Add all other lines
      newLines.push(line);
    }

    // If profile wasn't found, add it at the end
    if (!profileFound) {
      // Add a blank line if the file doesn't end with one
      if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") {
        newLines.push("");
      }

      newLines.push(`[${profileName}]`);
      newLines.push(`aws_access_key_id = ${credentials.accessKeyId}`);
      newLines.push(`aws_secret_access_key = ${credentials.secretAccessKey}`);
      newLines.push(`aws_session_token = ${credentials.sessionToken}`);
    }

    // Write the updated content back to the file
    fs.writeFileSync(credentialsPath, newLines.join("\n"));

    return true;
  } catch (error) {
    console.error("Error updating AWS credentials file:", error);
    throw error;
  }
}

/**
 * Format expiration time in a human-readable format
 * @param {Date} date The expiration date
 * @returns {String} Formatted expiration time
 */
function formatExpirationTime(date) {
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffHrs = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  return `${diffHrs}h ${diffMins}m`;
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  console.log("AWS SSO Login extension is now active - DEBUG");

  // Log all available commands
  vscode.commands.getCommands().then((commands) => {
    console.log("Available commands:", commands);
  });

  // Register the login command
  let loginDisposable = vscode.commands.registerCommand(
    "awsSsoLogin.login",
    async function () {
      console.log("Login command executed");
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

        // Check if token is valid
        const isTokenValid = await isSsoTokenValid(profile);

        // If token is not valid, start SSO login
        if (!isTokenValid) {
          const loginSuccess = await startSsoLogin(profile);
          if (!loginSuccess) {
            return;
          }
        }

        // Get credentials
        const credentials = await getAwsCredentials(profile);

        // Update credentials file
        await updateAwsCredentialsFile(profile.name, credentials);

        // Show success message with expiration time
        const expirationTime = formatExpirationTime(credentials.expiration);
        vscode.window.showInformationMessage(
          `AWS SSO login successful for profile: ${profile.name}. Credentials will expire in ${expirationTime}.`
        );
      } catch (error) {
        console.error("AWS SSO login error:", error);
        vscode.window.showErrorMessage(
          `AWS SSO login failed: ${error.message}`
        );
      }
    }
  );

  context.subscriptions.push(loginDisposable);

  // Show notification that extension is ready
  vscode.window.showInformationMessage(
    'AWS SSO Login extension is ready. Try running the "AWS SSO: Login with Profile" command.'
  );
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    parseAwsConfig  // Export for testing
};
