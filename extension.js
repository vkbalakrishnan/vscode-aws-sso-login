const vscode = require('vscode');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('AWS SSO Login extension is now active');
    
    // Register a simple command that just shows a message
    let disposable = vscode.commands.registerCommand('awsSsoLogin.test', function () {
        vscode.window.showInformationMessage('AWS SSO Login Test Command Executed!');
    });
    
    context.subscriptions.push(disposable);
    
    // Show notification that extension is ready
    vscode.window.showInformationMessage('AWS SSO Login extension is ready. Try running the "AWS SSO: Test" command.');
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
