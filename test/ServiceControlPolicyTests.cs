using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

namespace CommandCenter.Control.Tests
{
    internal static class ServiceControlPolicyTests
    {
        private static int failures;

        [STAThread]
        private static int Main()
        {
            Run("autostart policy matrix", TestAutoStartPolicyMatrix);
            Run("action availability matrix", TestActionAvailabilityMatrix);
            Run("autostart store fail closed", TestAutoStartStore);
            Run("KIF logical identity survives preview changes", TestKifContractIdentity);
            Run("Skaperverksted RFID stays local and uses trusted scripts", TestSkaperverkstedRfidContract);
            Run("shared runner launches Windows PowerShell 5.1 with CLIXML", TestWindowsPowerShell51Runner);
            Run("shared runner enforces timeout while capturing output", TestWindowsPowerShellRunnerTimeout);

            if (failures != 0)
            {
                Console.Error.WriteLine("FAILED: " + failures + " service-control policy test(s)");
                return 1;
            }

            Console.WriteLine("PASS: service-control policy tests");
            return 0;
        }

        private static void Run(string name, Action test)
        {
            try
            {
                test();
                Console.WriteLine("PASS: " + name);
            }
            catch (Exception exception)
            {
                failures++;
                Console.Error.WriteLine("FAIL: " + name + ": " + Unwrap(exception).Message);
            }
        }

        private static Exception Unwrap(Exception exception)
        {
            var invocation = exception as TargetInvocationException;
            return invocation != null && invocation.InnerException != null ? invocation.InnerException : exception;
        }

        private static Type RequireType(string name)
        {
            var type = typeof(ServiceControlPolicyTests).Assembly.GetType("KristianLiverod.CommandCenter.Control." + name, false);
            if (type == null)
            {
                throw new InvalidOperationException("Missing type " + name);
            }
            return type;
        }

        private static MethodInfo RequireMethod(Type type, string name, BindingFlags flags)
        {
            var method = type.GetMethods(flags).FirstOrDefault(candidate => candidate.Name == name);
            if (method == null)
            {
                throw new InvalidOperationException("Missing method " + type.Name + "." + name);
            }
            return method;
        }

        private static object EnumValue(Type enumType, string value)
        {
            return Enum.Parse(enumType, value, true);
        }

        private static object[] MakePolicyArguments(MethodInfo method, string environment, string policy, bool enabled)
        {
            var arguments = new List<object>();
            foreach (var parameter in method.GetParameters())
            {
                if (parameter.ParameterType.IsEnum && parameter.ParameterType.Name.IndexOf("Environment", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    arguments.Add(EnumValue(parameter.ParameterType, environment));
                }
                else if (parameter.ParameterType.IsEnum && parameter.ParameterType.Name.IndexOf("Policy", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    arguments.Add(EnumValue(parameter.ParameterType, policy));
                }
                else if (parameter.ParameterType == typeof(bool))
                {
                    arguments.Add(enabled);
                }
                else
                {
                    throw new InvalidOperationException("Unexpected policy parameter " + parameter.Name);
                }
            }
            return arguments.ToArray();
        }

        private static void TestAutoStartPolicyMatrix()
        {
            var registry = RequireType("ServiceRegistry");
            var method = RequireMethod(registry, "IsAutoStartCandidate", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);

            AssertEqual(true, Convert.ToBoolean(method.Invoke(null, MakePolicyArguments(method, "Production", "ControlManaged", true))), "enabled production ControlManaged service must start");
            AssertEqual(false, Convert.ToBoolean(method.Invoke(null, MakePolicyArguments(method, "Production", "ControlManaged", false))), "disabled ControlManaged service must not start");
            AssertEqual(false, Convert.ToBoolean(method.Invoke(null, MakePolicyArguments(method, "Production", "ExternallyManaged", true))), "externally managed service must not start");
            AssertEqual(false, Convert.ToBoolean(method.Invoke(null, MakePolicyArguments(method, "Test", "ManualOnly", true))), "test service must remain manual even if config says enabled");
        }

        private static void TestActionAvailabilityMatrix()
        {
            var availabilityType = RequireType("ServiceActionAvailability");
            var stateType = RequireType("LocalServiceState");
            var factory = availabilityType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                .FirstOrDefault(method => method.ReturnType == availabilityType && method.GetParameters().Length == 1 && method.GetParameters()[0].ParameterType == stateType);
            if (factory == null)
            {
                throw new InvalidOperationException("Missing ServiceActionAvailability state factory");
            }

            var running = factory.Invoke(null, new[] { EnumValue(stateType, "Online") });
            var stopped = factory.Invoke(null, new[] { EnumValue(stateType, "Offline") });
            AssertProperty(running, "CanStart", false);
            AssertProperty(running, "CanStop", true);
            AssertProperty(running, "CanRestart", true);
            AssertProperty(stopped, "CanStart", true);
            AssertProperty(stopped, "CanStop", false);
        }

        private static void TestAutoStartStore()
        {
            var tempRoot = Path.Combine(Path.GetTempPath(), "command-center-service-policy-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            try
            {
                var storeType = RequireType("ServiceAutoStartStore");
                var constructor = storeType.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .FirstOrDefault(candidate => candidate.GetParameters().Length == 1 && candidate.GetParameters()[0].ParameterType == typeof(string));
                if (constructor == null)
                {
                    throw new InvalidOperationException("Missing ServiceAutoStartStore constructor");
                }
                var store = constructor.Invoke(new object[] { tempRoot });
                var isEnabled = RequireMethod(storeType, "IsEnabled", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
                var setEnabled = RequireMethod(storeType, "SetEnabled", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);

                AssertEqual(false, Convert.ToBoolean(isEnabled.Invoke(store, new object[] { "command-center" })), "Command Center service default must be off");
                setEnabled.Invoke(store, new object[] { "command-center", true });
                AssertEqual(true, Convert.ToBoolean(isEnabled.Invoke(store, new object[] { "command-center" })), "Command Center service setting must persist");

                var rejected = false;
                try
                {
                    setEnabled.Invoke(store, new object[] { "kif-test", true });
                }
                catch (TargetInvocationException)
                {
                    rejected = true;
                }
                AssertEqual(true, rejected, "KIF Test must be rejected by writable autostart config");

                var configPath = Path.Combine(tempRoot, ".runtime", "control", "service-autostart.json");
                File.WriteAllText(configPath, "{\"command-center\":false,\"kif-test\":true}");
                var reloaded = constructor.Invoke(new object[] { tempRoot });
                AssertEqual(false, Convert.ToBoolean(isEnabled.Invoke(reloaded, new object[] { "kif-test" })), "KIF Test must fail closed even when injected into local config");
            }
            finally
            {
                try { Directory.Delete(tempRoot, true); } catch { }
            }
        }

        private static void TestKifContractIdentity()
        {
            var resultType = RequireType("KifContractResult");
            var parse = RequireMethod(resultType, "Parse", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            var first = parse.Invoke(null, new object[] { "{\"serviceId\":\"kif-test\",\"environment\":\"Test\",\"state\":\"Running\",\"healthy\":true,\"port\":8126,\"branch\":\"codex/preview-a\",\"commit\":\"aaaa\"}" });
            var second = parse.Invoke(null, new object[] { "{\"serviceId\":\"kif-test\",\"environment\":\"Test\",\"state\":\"Running\",\"healthy\":true,\"port\":8126,\"branch\":\"codex/preview-b\",\"commit\":\"bbbb\"}" });
            AssertProperty(first, "ServiceId", "kif-test");
            AssertProperty(second, "ServiceId", "kif-test");
            AssertProperty(first, "Port", 8126);
            AssertProperty(second, "Port", 8126);
        }

        private static void TestSkaperverkstedRfidContract()
        {
            var adapterType = RequireType("SkaperverkstedRfidServiceAdapter");
            var adapter = Activator.CreateInstance(adapterType, true);
            AssertProperty(adapter, "Id", "skaperverksted-rfid");
            AssertProperty(adapter, "DisplayName", "Skaperverksted RFID");
            AssertProperty(adapter, "Endpoint", "http://127.0.0.1:8787/");
            AssertProperty(adapter, "Environment", EnumValue(RequireType("LocalServiceEnvironment"), "Test"));
            AssertProperty(adapter, "AutoStartPolicy", EnumValue(RequireType("AutoStartPolicy"), "ManualOnly"));

            var scriptName = RequireMethod(adapterType, "ScriptNameForAction", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            AssertEqual("Start-Skaperverksted.ps1", scriptName.Invoke(null, new object[] { "start" }), "RFID start script");
            AssertEqual("Stop-Skaperverksted.ps1", scriptName.Invoke(null, new object[] { "stop" }), "RFID stop script");
            AssertEqual("Restart-Skaperverksted.ps1", scriptName.Invoke(null, new object[] { "restart" }), "RFID restart script");

            var categorizeFailure = RequireMethod(adapterType, "CategorizeActionFailure", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            AssertRfidActionFailureCategories(categorizeFailure);

            var runnerType = RequireType("ProcessRunner");
            var buildArguments = RequireMethod(runnerType, "BuildPowerShellArguments", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            AssertScriptUsesManualTest(buildArguments, @"C:\Skaperverksted\source\scripts\Start-Skaperverksted.ps1", false);
            AssertScriptUsesManualTest(buildArguments, @"C:\Skaperverksted\source\scripts\Stop-Skaperverksted.ps1", false);
            AssertScriptUsesManualTest(buildArguments, @"C:\Skaperverksted\source\scripts\Restart-Skaperverksted.ps1", false);
            AssertScriptUsesManualTest(buildArguments, @"C:\Skaperverksted\source\scripts\Test-SkaperverkstedHealth.ps1", true);

            var healthType = RequireType("RfidHealthResult");
            var parse = RequireMethod(healthType, "Parse", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            string healthyXml = "#< CLIXML\n<Objs><Obj><MS><S N=\"Status\">Healthy</S><S N=\"Address\">127.0.0.1</S><I32 N=\"Port\">8787</I32><I32 N=\"PID\">4242</I32><S N=\"Process\">python</S><S N=\"Executable\">C:\\Skaperverksted\\runtime\\venv\\Scripts\\python.exe</S><S N=\"Ownership\">Verified</S><S N=\"ListenerOwnership\">Verified</S><I32 N=\"ListenerPID\">4242</I32><S N=\"LaunchMode\">manual-test</S></MS></Obj></Objs>";
            var healthy = parse.Invoke(null, new object[] { healthyXml });
            AssertProperty(healthy, "Status", "Healthy");
            AssertProperty(healthy, "Port", 8787);
            AssertProperty(healthy, "ProcessId", 4242);
            AssertProperty(healthy, "Healthy", true);
            AssertProperty(healthy, "ManualTestOwnershipVerified", true);

            string mismatchedListenerXml = healthyXml.Replace("<I32 N=\"ListenerPID\">4242</I32>", "<I32 N=\"ListenerPID\">4343</I32>");
            var mismatchedListener = parse.Invoke(null, new object[] { mismatchedListenerXml });
            AssertProperty(mismatchedListener, "ManualTestOwnershipVerified", false);

            string unhealthyXml = "#< CLIXML\n<Objs><Obj><MS><S N=\"Status\">Unhealthy</S><S N=\"Detail\">Health request failed</S></MS></Obj></Objs>";
            var unhealthy = parse.Invoke(null, new object[] { unhealthyXml });
            AssertProperty(unhealthy, "Healthy", false);
            AssertProperty(unhealthy, "ManualTestOwnershipVerified", false);
            AssertProperty(unhealthy, "Detail", "Health request failed");
        }

        private static void AssertRfidActionFailureCategories(MethodInfo categorizeFailure)
        {
            const string commandLineCategory = "ManualTest process command line did not match expected runtime contract.";
            const string safeFallback = "ManualTest action failed. Review protected logs.";

            AssertEqual(
                commandLineCategory,
                categorizeFailure.Invoke(null, new object[] { commandLineCategory }),
                "RFID explicit command-line category");
            AssertEqual(
                commandLineCategory,
                categorizeFailure.Invoke(null, new object[]
                {
                    "Server startup did not produce a healthy listener. PID 51512 command line does not exactly match the requested owned runtime."
                }),
                "RFID current command-line mismatch");
            AssertEqual(
                commandLineCategory,
                categorizeFailure.Invoke(null, new object[]
                {
                    "Server startup did not produce runtime metadata. PID 51512 command line does not exactly match the expected Skaperverksted runtime."
                }),
                "RFID installed command-line mismatch");
            AssertEqual(
                commandLineCategory,
                categorizeFailure.Invoke(null, new object[]
                {
                    "PID 51512 command line does not exactly\r\nmatch the expected Skaperverksted runtime."
                }),
                "RFID wrapped command-line mismatch");
            AssertEqual(
                safeFallback,
                categorizeFailure.Invoke(null, new object[]
                {
                    "Unknown failure --config C:\\private\\production.env secret=do-not-display"
                }),
                "RFID unknown action failure stays generic");
            AssertEqual(
                safeFallback,
                categorizeFailure.Invoke(null, new object[] { null }),
                "RFID missing action diagnostic stays generic");
            AssertEqual(
                safeFallback,
                categorizeFailure.Invoke(null, new object[]
                {
                    "PID 51512 command line differs --config C:\\private\\production.env secret=do-not-display"
                }),
                "RFID near-miss diagnostic stays generic");
            AssertEqual(true, commandLineCategory.Length < 90, "RFID command-line category must fit the action label");
            AssertEqual(true, safeFallback.Length < 90, "RFID fallback must fit the action label");
            AssertEqual(false, safeFallback.Contains("production.env"), "RFID fallback must not reveal source diagnostics");
        }

        private static void AssertScriptUsesManualTest(MethodInfo buildArguments, string scriptPath, bool cliXml)
        {
            string arguments = Convert.ToString(buildArguments.Invoke(null, new object[] { scriptPath, "-ManualTest", cliXml }));
            int outputFormatIndex = arguments.IndexOf("-OutputFormat XML", StringComparison.OrdinalIgnoreCase);
            int fileIndex = arguments.IndexOf("-File", StringComparison.OrdinalIgnoreCase);
            int scriptIndex = arguments.IndexOf(Path.GetFileName(scriptPath), StringComparison.OrdinalIgnoreCase);
            int manualTestIndex = arguments.IndexOf("-ManualTest", StringComparison.Ordinal);
            AssertEqual(true, fileIndex >= 0, scriptPath + " must use -File");
            AssertEqual(true, scriptIndex > fileIndex, scriptPath + " must target the trusted script after -File");
            AssertEqual(true, manualTestIndex > scriptIndex, scriptPath + " must pass ManualTest as a script argument");
            AssertEqual(cliXml, outputFormatIndex >= 0, scriptPath + " XML mode");
            if (cliXml)
            {
                AssertEqual(true, outputFormatIndex < fileIndex, scriptPath + " must place OutputFormat before -File");
            }
        }

        private static void TestWindowsPowerShell51Runner()
        {
            string tempRoot = Path.Combine(Path.GetTempPath(), "command-center-powershell-test-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            string scriptPath = Path.Combine(tempRoot, "engine-contract.ps1");
            File.WriteAllText(
                scriptPath,
                "param([switch] $ManualTest)\r\n[pscustomobject] @{ Major = $PSVersionTable.PSVersion.Major; Edition = $PSVersionTable.PSEdition; ManualTest = [bool] $ManualTest }\r\n");
            try
            {
                var runnerType = RequireType("ProcessRunner");
                var runMethod = runnerType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                    .Single(method => method.Name == "RunPowerShellAsync" && method.GetParameters().Length == 6);
                var task = (System.Threading.Tasks.Task)runMethod.Invoke(
                    null,
                    new object[] { scriptPath, "-ManualTest", tempRoot, false, 15000, true });
                task.Wait();
                object result = task.GetType().GetProperty("Result").GetValue(task, null);
                string output = Convert.ToString(result.GetType().GetField("Output", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).GetValue(result));
                int exitCode = Convert.ToInt32(result.GetType().GetField("ExitCode", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance).GetValue(result));
                AssertEqual(0, exitCode, "Windows PowerShell runner exit code");
                AssertEqual(true, output.IndexOf("<I32 N=\"Major\">5</I32>", StringComparison.OrdinalIgnoreCase) >= 0, "runner must use Windows PowerShell 5.1");
                AssertEqual(true, output.IndexOf("<B N=\"ManualTest\">true</B>", StringComparison.OrdinalIgnoreCase) >= 0, "runner must preserve ManualTest");
            }
            finally
            {
                try { Directory.Delete(tempRoot, true); } catch { }
            }
        }

        private static void TestWindowsPowerShellRunnerTimeout()
        {
            string tempRoot = Path.Combine(Path.GetTempPath(), "command-center-powershell-timeout-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempRoot);
            string scriptPath = Path.Combine(tempRoot, "timeout-contract.ps1");
            File.WriteAllText(scriptPath, "Start-Sleep -Seconds 30\r\n");
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                var runnerType = RequireType("ProcessRunner");
                var runMethod = runnerType.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)
                    .Single(method => method.Name == "RunPowerShellAsync" && method.GetParameters().Length == 6);
                var task = (System.Threading.Tasks.Task)runMethod.Invoke(
                    null,
                    new object[] { scriptPath, String.Empty, tempRoot, false, 300, false });
                bool timedOut = false;
                try
                {
                    task.Wait();
                }
                catch (AggregateException error)
                {
                    timedOut = error.Flatten().InnerExceptions.Any(exception => exception is TimeoutException);
                }
                AssertEqual(true, timedOut, "runner must report its bounded timeout");
                AssertEqual(true, stopwatch.Elapsed < TimeSpan.FromSeconds(7), "runner timeout must not be blocked by redirected streams");
            }
            finally
            {
                stopwatch.Stop();
                try { Directory.Delete(tempRoot, true); } catch { }
            }
        }

        private static void AssertProperty(object target, string name, object expected)
        {
            var property = target.GetType().GetProperty(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (property != null)
            {
                AssertEqual(expected, property.GetValue(target, null), name);
                return;
            }
            var field = target.GetType().GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (field == null)
            {
                throw new InvalidOperationException("Missing member " + target.GetType().Name + "." + name);
            }
            AssertEqual(expected, field.GetValue(target), name);
        }

        private static void AssertEqual(object expected, object actual, string message)
        {
            if (!object.Equals(expected, actual))
            {
                throw new InvalidOperationException(message + ": expected " + expected + ", got " + actual);
            }
        }
    }
}
