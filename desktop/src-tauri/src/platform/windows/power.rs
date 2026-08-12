use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};

use crate::platform::{NativePowerStateProvider, PowerSample};

pub struct WindowsPowerStateProvider;

impl NativePowerStateProvider for WindowsPowerStateProvider {
    fn read(&self) -> PowerSample {
        let mut status = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut status) }.is_err() {
            return PowerSample::Unavailable;
        }
        // 255 means unknown in both fields; report unavailable rather than inventing numbers.
        if status.ACLineStatus == 255 || status.BatteryLifePercent == 255 {
            return PowerSample::Unavailable;
        }
        PowerSample::Available {
            on_battery: status.ACLineStatus == 0,
            battery_percent: f64::from(status.BatteryLifePercent),
        }
    }
}
