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