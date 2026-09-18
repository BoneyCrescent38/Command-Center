using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;
using KristianLiverod.CommandCenter.Control;

namespace CommandCenter.Control.Tests
{
    internal static class ServiceActionLockTests
    {
        internal static void RunAll()
        {
            TestRegistryExcludesOverlappingActionsPerService();
            TestRestartRemainsOneRegistryAction();
            TestRegistryReleasesAfterErrorAndTimeout();
            TestRfidPendingStateSurvivesRefresh();
            TestNonRfidRefreshBehaviorIsUnchanged();
        }

        private static void TestRegistryExcludesOverlappingActionsPerService()
        {
            using (RegistryFixture fixture = new RegistryFixture())
            {
                TaskCompletionSource<object> firstGate = NewGate();
                Queue<Task> rfidResults = new Queue<Task>();
                rfidResults.Enqueue(firstGate.Task);
                rfidResults.Enqueue(SuccessfulTask());
                ControlledAdapter rfid = new ControlledAdapter(
                    "skaperverksted-rfid",
                    "Skaperverksted RFID",
                    delegate { return rfidResults.Dequeue(); });
                ControlledAdapter dashboard = new ControlledAdapter(
                    "project-dashboard",
                    "Project Dashboard",
                    delegate { return SuccessfulTask(); });
                fixture.Replace(rfid);
                fixture.Replace(dashboard);

                Task running = fixture.Registry.ExecuteAsync(rfid.Id, "restart", null);
                AssertEqual(false, running.IsCompleted, "first RFID action must remain in flight");
                AssertEqual(1, rfid.Actions.Count, "registry must dispatch the first RFID action once");
                AssertEqual("restart", rfid.Actions[0], "registry must preserve the requested action");

                AssertBusyRejection(fixture.Registry, rfid, "start");
                AssertBusyRejection(fixture.Registry, rfid, "stop");
                AssertBusyRejection(fixture.Registry, rfid, "restart");
                AssertEqual(1, rfid.Actions.Count, "overlapping actions must not reach the adapter");

                Await(fixture.Registry.ExecuteAsync(dashboard.Id, "start", null));
                AssertEqual(1, dashboard.Actions.Count, "another service must not share the RFID lock");
                AssertEqual(false, running.IsCompleted, "another service must not complete the RFID action");

                firstGate.SetResult(null);
                Await(running);
                Await(fixture.Registry.ExecuteAsync(rfid.Id, "start", null));
                AssertEqual(2, rfid.Actions.Count, "successful completion must release the RFID lock");
                AssertEqual("start", rfid.Actions[1], "next action must run after successful completion");
            }
        }

        private static void TestRestartRemainsOneRegistryAction()
        {
            using (RegistryFixture fixture = new RegistryFixture())
            {
                TaskCompletionSource<object> stopGate = NewGate();
                TaskCompletionSource<object> startGate = NewGate();
                List<string> internalSteps = new List<string>();
                ControlledAdapter rfid = new ControlledAdapter(
                    "skaperverksted-rfid",
                    "Skaperverksted RFID",
                    delegate(string action)
                    {
                        if (!String.Equals(action, "restart", StringComparison.Ordinal))
                        {
                            throw new InvalidOperationException("Unexpected fake action.");
                        }
                        return RunInternalRestartAsync(stopGate.Task, startGate.Task, internalSteps);
                    });
                fixture.Replace(rfid);

                Task restart = fixture.Registry.ExecuteAsync(rfid.Id, "restart", null);
                AssertSequence(internalSteps, new[] { "stop" }, "restart must begin with its internal stop");
                AssertEqual(1, rfid.Actions.Count, "restart must be one registry adapter call");
                AssertBusyRejection(fixture.Registry, rfid, "start");

                stopGate.SetResult(null);
                WaitUntil(delegate { return internalSteps.Count == 2; }, "restart did not enter its internal start");
                AssertSequence(internalSteps, new[] { "stop", "start" }, "restart internal phase order");
                AssertEqual(1, rfid.Actions.Count, "internal start must not reacquire the registry");

                startGate.SetResult(null);
                Await(restart);
                AssertEqual(1, rfid.Actions.Count, "completed restart must remain one adapter call");
            }
        }

        private static void TestRegistryReleasesAfterErrorAndTimeout()
        {
            using (RegistryFixture fixture = new RegistryFixture())
            {
                TaskCompletionSource<object> errorGate = NewGate();
                TaskCompletionSource<object> timeoutGate = NewGate();
                Queue<Task> results = new Queue<Task>();
                results.Enqueue(errorGate.Task);
                results.Enqueue(SuccessfulTask());
                results.Enqueue(timeoutGate.Task);
                results.Enqueue(SuccessfulTask());
                ControlledAdapter rfid = new ControlledAdapter(
                    "skaperverksted-rfid",
                    "Skaperverksted RFID",
                    delegate { return results.Dequeue(); });
                fixture.Replace(rfid);

                Task failed = fixture.Registry.ExecuteAsync(rfid.Id, "start", null);
                AssertEqual(false, failed.IsCompleted, "failing action must first remain pending");
                AssertBusyRejection(fixture.Registry, rfid, "stop");
                errorGate.SetException(new InvalidOperationException("controlled failure"));
                AssertThrows<InvalidOperationException>(
                    delegate { Await(failed); },
                    "adapter error must propagate");
                Await(fixture.Registry.ExecuteAsync(rfid.Id, "start", null));

                Task timedOut = fixture.Registry.ExecuteAsync(rfid.Id, "stop", null);
                AssertEqual(false, timedOut.IsCompleted, "timing-out action must first remain pending");
                AssertBusyRejection(fixture.Registry, rfid, "restart");
                timeoutGate.SetException(new TimeoutException("controlled timeout"));
                AssertThrows<TimeoutException>(
                    delegate { Await(timedOut); },
                    "adapter timeout must propagate");
                Await(fixture.Registry.ExecuteAsync(rfid.Id, "restart", null));

                AssertSequence(
                    rfid.Actions,
                    new[] { "start", "start", "stop", "restart" },
                    "error and timeout must both release the RFID lock");
            }
        }

        private static void TestRfidPendingStateSurvivesRefresh()
        {
            ControlledAdapter rfid = new ControlledAdapter(
                "skaperverksted-rfid",
                "Skaperverksted RFID",
                delegate { return SuccessfulTask(); });
            using (ServiceCardControl card = new ServiceCardControl(rfid))
            {
                card.Apply(Status(rfid, LocalServiceState.Offline));
                card.SetPending("start");
                AssertPendingCard(card, "STARTING", "RFID start before refresh");
                card.Apply(Status(rfid, LocalServiceState.Online));
                AssertPendingCard(card, "STARTING", "RFID start after healthy refresh");
                card.CompletePending();
                AssertEqual(false, card.IsActionPending, "completed RFID start must clear pending state");
                AssertEqual("ONLINE", Field<Label>(card, "stateLabel").Text, "completed start must show last observed state");
                AssertActionButtons(card, false, true, true, "completed RFID start action availability");

                card.Apply(Status(rfid, LocalServiceState.Online));
                card.SetPending("stop");
                AssertPendingCard(card, "STOPPING", "RFID stop before refresh");
                card.Apply(Status(rfid, LocalServiceState.Offline));
                AssertPendingCard(card, "STOPPING", "RFID stop after offline refresh");
                card.CompletePending();
                AssertEqual(false, card.IsActionPending, "completed RFID stop must clear pending state");
                AssertEqual("OFFLINE", Field<Label>(card, "stateLabel").Text, "completed stop must show last observed state");
                AssertActionButtons(card, true, false, false, "completed RFID stop action availability");

                card.Apply(Status(rfid, LocalServiceState.Online));
                card.SetPending("restart");
                AssertPendingCard(card, "STOPPING", "RFID restart must begin by stopping");
                card.Apply(Status(rfid, LocalServiceState.Online));
                AssertPendingCard(card, "STOPPING", "RFID restart must remain stopping while still online");
                card.Apply(Status(rfid, LocalServiceState.Offline));
                AssertPendingCard(card, "STARTING", "RFID restart must switch to starting after offline refresh");
                card.Apply(Status(rfid, LocalServiceState.Online));
                AssertPendingCard(card, "STARTING", "RFID restart must remain pending after recovery");
                card.CompletePending();
                AssertEqual(false, card.IsActionPending, "completed RFID restart must clear pending state");
                AssertEqual("ONLINE", Field<Label>(card, "stateLabel").Text, "completed restart must show last observed state");
                AssertActionButtons(card, false, true, true, "completed RFID restart action availability");

                card.Apply(Status(rfid, LocalServiceState.Offline));
                card.SetPending("start");
                card.Apply(Status(rfid, LocalServiceState.Error));
                AssertPendingCard(card, "STARTING", "RFID start after error observation");
                card.CompletePending();
                AssertEqual(false, card.IsActionPending, "failed RFID action must clear pending state");
                AssertEqual("ERROR", Field<Label>(card, "stateLabel").Text, "failed action must show last observed error");
                AssertActionButtons(card, true, false, true, "failed RFID action availability");
            }
        }

        private static void TestNonRfidRefreshBehaviorIsUnchanged()
        {
            ControlledAdapter dashboard = new ControlledAdapter(
                "project-dashboard",
                "Project Dashboard",
                delegate { return SuccessfulTask(); });
            using (ServiceCardControl card = new ServiceCardControl(dashboard))
            {
                card.Apply(Status(dashboard, LocalServiceState.Online));
                card.SetPending("restart");
                AssertEqual(false, card.IsActionPending, "non-RFID cards must not retain RFID pending state");
                AssertEqual("STARTING", Field<Label>(card, "stateLabel").Text, "non-RFID restart transient state");
                AssertActionButtons(card, false, false, false, "non-RFID transient busy state");

                card.Apply(Status(dashboard, LocalServiceState.Offline));
                AssertEqual("OFFLINE", Field<Label>(card, "stateLabel").Text, "non-RFID refresh must replace transient state");
                AssertActionButtons(card, true, false, false, "non-RFID refresh action availability");
            }
        }

        private static async Task RunInternalRestartAsync(
            Task stopGate,
            Task startGate,
            List<string> internalSteps)
        {
            internalSteps.Add("stop");
            await stopGate.ConfigureAwait(false);
            internalSteps.Add("start");
            await startGate.ConfigureAwait(false);
        }

        private static void AssertBusyRejection(ServiceRegistry registry, ControlledAdapter adapter, string action)
        {
            try
            {
                Await(registry.ExecuteAsync(adapter.Id, action, null));
            }
            catch (InvalidOperationException error)
            {
                AssertEqual(
                    "An action is already running for " + adapter.DisplayName + ".",
                    error.Message,
                    "busy rejection message");
                return;
            }
            throw new InvalidOperationException("overlapping " + action + " action was not rejected");
        }

        private static void AssertPendingCard(ServiceCardControl card, string expectedState, string context)
        {
            AssertEqual(true, card.IsActionPending, context + " pending flag");
            AssertEqual(expectedState, Field<Label>(card, "stateLabel").Text, context + " state label");
            AssertActionButtons(card, false, false, false, context + " action buttons");
            AssertEqual(false, Field<Button>(card, "openButton").Enabled, context + " open button");
            AssertEqual(false, Field<CheckBox>(card, "autoStartCheckBox").Enabled, context + " auto-start checkbox");
        }

        private static void AssertActionButtons(
            ServiceCardControl card,
            bool canStart,
            bool canStop,
            bool canRestart,
            string context)
        {
            AssertEqual(canStart, Field<Button>(card, "startButton").Enabled, context + " start");
            AssertEqual(canStop, Field<Button>(card, "stopButton").Enabled, context + " stop");
            AssertEqual(canRestart, Field<Button>(card, "restartButton").Enabled, context + " restart");
        }

        private static ServiceStatusSnapshot Status(ControlledAdapter adapter, LocalServiceState state)
        {
            return new ServiceStatusSnapshot
            {
                Id = adapter.Id,
                DisplayName = adapter.DisplayName,
                Environment = adapter.Environment,
                Endpoint = adapter.Endpoint,
                State = state,
                AutoStartPolicy = adapter.AutoStartPolicy,
                CheckedAt = DateTime.Now
            };
        }

        private static T Field<T>(object target, string name) where T : class
        {
            FieldInfo field = target.GetType().GetField(name, BindingFlags.Instance | BindingFlags.NonPublic);
            if (field == null)
            {
                throw new InvalidOperationException("Missing field " + target.GetType().Name + "." + name);
            }
            T value = field.GetValue(target) as T;
            if (value == null)
            {
                throw new InvalidOperationException("Unexpected field type for " + target.GetType().Name + "." + name);
            }
            return value;
        }

        private static TaskCompletionSource<object> NewGate()
        {
            return new TaskCompletionSource<object>();
        }

        private static Task SuccessfulTask()
        {
            TaskCompletionSource<object> source = NewGate();
            source.SetResult(null);
            return source.Task;
        }

        private static void Await(Task task)
        {
            task.GetAwaiter().GetResult();
        }

        private static void WaitUntil(Func<bool> condition, string failureMessage)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(2);
            while (!condition() && DateTime.UtcNow < deadline)
            {
                System.Threading.Thread.Sleep(10);
            }
            if (!condition())
            {
                throw new InvalidOperationException(failureMessage);
            }
        }

        private static void AssertThrows<TException>(Action action, string message)
            where TException : Exception
        {
            try
            {
                action();
            }
            catch (TException)
            {
                return;
            }
            throw new InvalidOperationException(message);
        }

        private static void AssertSequence(IList<string> actual, string[] expected, string message)
        {
            AssertEqual(expected.Length, actual.Count, message + " count");
            for (int index = 0; index < expected.Length; index++)
            {
                AssertEqual(expected[index], actual[index], message + " item " + index);
            }
        }

        private static void AssertEqual(object expected, object actual, string message)
        {
            if (!Object.Equals(expected, actual))
            {
                throw new InvalidOperationException(message + ": expected " + expected + ", got " + actual);
            }
        }

        private sealed class ControlledAdapter : IServiceAdapter
        {
            private readonly Func<string, Task> execute;

            internal ControlledAdapter(string id, string displayName, Func<string, Task> execute)
            {
                Id = id;
                DisplayName = displayName;
                this.execute = execute;
            }

            public string Id { get; private set; }
            public string DisplayName { get; private set; }
            public LocalServiceEnvironment Environment { get { return LocalServiceEnvironment.Test; } }
            public string Endpoint { get { return "http://127.0.0.1:1/"; } }
            public AutoStartPolicy AutoStartPolicy { get { return AutoStartPolicy.ManualOnly; } }
            internal readonly List<string> Actions = new List<string>();

            public Task<ServiceStatusSnapshot> GetStatusAsync()
            {
                return Task.FromResult(Status(this, LocalServiceState.Offline));
            }

            public Task ExecuteAsync(string action, Action<string> progress)
            {
                Actions.Add(action);
                return execute(action);
            }
        }

        private sealed class RegistryFixture : IDisposable
        {
            private readonly string fixtureRoot;

            internal RegistryFixture()
            {
                fixtureRoot = Path.Combine(
                    Path.GetTempPath(),
                    "command-center-action-lock-" + Guid.NewGuid().ToString("N"));
                string repositoryRoot = Path.Combine(fixtureRoot, "CommandCenter");
                string kifScripts = Path.Combine(
                    fixtureRoot,
                    "Turn",
                    "kif-v3.4-bredde-foundation",
                    "scripts");
                Directory.CreateDirectory(repositoryRoot);
                Directory.CreateDirectory(kifScripts);
                File.WriteAllText(Path.Combine(kifScripts, "command-center-service.ps1"), "# inert test fixture\r\n");

                CommandCenterRuntime runtime = new CommandCenterRuntime(repositoryRoot);
                Registry = new ServiceRegistry(repositoryRoot, runtime);
            }

            internal ServiceRegistry Registry { get; private set; }

            internal void Replace(IServiceAdapter adapter)
            {
                FieldInfo field = typeof(ServiceRegistry).GetField(
                    "byId",
                    BindingFlags.Instance | BindingFlags.NonPublic);
                if (field == null)
                {
                    throw new InvalidOperationException("Missing ServiceRegistry.byId field.");
                }
                Dictionary<string, IServiceAdapter> adapters =
                    field.GetValue(Registry) as Dictionary<string, IServiceAdapter>;
                if (adapters == null || !adapters.ContainsKey(adapter.Id))
                {
                    throw new InvalidOperationException("Missing fixture adapter " + adapter.Id + ".");
                }
                adapters[adapter.Id] = adapter;
            }

            public void Dispose()
            {
                try { Directory.Delete(fixtureRoot, true); }
                catch { }
            }
        }
    }
}
