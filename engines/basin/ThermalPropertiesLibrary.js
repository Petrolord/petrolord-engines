/**
 * Thermal Properties Library
 * Values are approximate averages for standard lithologies
 */

export const ThermalProperties = {
    sandstone: {
      conductivity: 3.5, // W/(m*K) - Matrix
      radiogenic: 1.2e-6, // W/m3
      heatCapacity: 900 // J/(kg*K)
    },
    shale: {
      conductivity: 1.8,
      radiogenic: 1.8e-6,
      heatCapacity: 1100
    },
    limestone: {
      conductivity: 2.8,
      radiogenic: 0.8e-6,
      heatCapacity: 950
    },
    salt: {
      conductivity: 5.5,
      radiogenic: 0.1e-6,
      heatCapacity: 850
    },
    coal: {
        conductivity: 0.3,
        radiogenic: 0.5e-6,
        heatCapacity: 1300
    },
    water: {
      conductivity: 0.6,
      radiogenic: 0,
      heatCapacity: 4186,
      density: 1030 // Formation water
    },
    default: {
      conductivity: 2.5,
      radiogenic: 1.0e-6,
      heatCapacity: 1000
    }
  };
  
  export const getThermalProps = (lithology) => {
    const key = lithology?.toLowerCase();
    return ThermalProperties[key] || ThermalProperties.default;
  };