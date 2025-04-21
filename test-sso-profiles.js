// Mock the vscode module
const vscode = {
  window: {
    createOutputChannel: function(name) {
      return {
        append: function(message) {
          console.log(`[${name}] ${message}`);
        },
        appendLine: function(message) {
          console.log(`[${name}] ${message}`);
        },
        show: function() {}
      };
    },
    showInformationMessage: function(message) {
      console.log(`[INFO] ${message}`);
    },
    showErrorMessage: function(message) {
      console.log(`[ERROR] ${message}`);
    },
    withProgress: async function(options, task) {
      console.log(`[PROGRESS] ${options.title}`);
      return await task({ report: (msg) => console.log(`[PROGRESS] ${msg.message}`) });
    },
    showQuickPick: async function() {
      return null;
    }
  },
  workspace: {
    getConfiguration: function() {
      return {
        get: function() {
          return [];
        }
      };
    }
  },
  commands: {
    getCommands: async function() {
      return [];
    },
    registerCommand: function() {
      return { dispose: function() {} };
    }
  },
  ProgressLocation: {
    Notification: 1
  }
};

// Mock other required modules
const mockModules = {
  '@aws-sdk/client-sso': {
    SSO: class {
      constructor() {}
      listAccounts() {
        return Promise.resolve({});
      }
      getRoleCredentials() {
        return Promise.resolve({
          roleCredentials: {
            accessKeyId: 'mock-access-key',
            secretAccessKey: 'mock-secret-key',
            sessionToken: 'mock-session-token',
            expiration: Date.now() + 3600000
          }
        });
      }
    }
  },
  '@aws-sdk/client-sso-oidc': {
    SSOOIDC: class {
      constructor() {}
    }
  }
};

// Override require to return our mocks for specific modules
const originalRequire = require;
require = function(moduleName) {
  if (moduleName === 'vscode') {
    return vscode;
  }
  if (mockModules[moduleName]) {
    return mockModules[moduleName];
  }
  return originalRequire(moduleName);
};

// Now require the extension
const extension = require('./extension');

// Test the parseAwsConfig function
async function testParseAwsConfig() {
  try {
    // Get the parseAwsConfig function from the extension
    const parseAwsConfig = extension.parseAwsConfig;
    
    if (!parseAwsConfig) {
      console.error("parseAwsConfig function not found in extension module");
      return;
    }
    
    console.log("Testing parseAwsConfig function...");
    const profiles = await parseAwsConfig();
    console.log("Parsed SSO Profiles:", JSON.stringify(profiles, null, 2));
    
    // Check if the gen-ai-login profile was correctly parsed
    if (profiles['gen-ai-login']) {
      console.log("✅ Successfully parsed gen-ai-login profile");
      console.log("Profile details:", profiles['gen-ai-login']);
    } else {
      console.log("❌ Failed to parse gen-ai-login profile");
    }
    
    // Check if the gen-ai profile was correctly parsed (if it should be included)
    if (profiles['gen-ai']) {
      console.log("✅ Successfully parsed gen-ai profile");
      console.log("Profile details:", profiles['gen-ai']);
    } else {
      console.log("ℹ️ gen-ai profile not included (expected if it's not an SSO profile)");
    }
    
  } catch (error) {
    console.error("Error testing parseAwsConfig:", error);
  }
}

// Run the test
testParseAwsConfig().then(() => {
  console.log("Test completed");
});
