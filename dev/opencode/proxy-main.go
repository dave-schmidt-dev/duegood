package main

import (
	"fmt"
	"log"
	"net"
	"net/http"

	"github.com/sirupsen/logrus"
	"github.com/stripe/smokescreen/cmd"
	"github.com/stripe/smokescreen/pkg/smokescreen"
)

func dueGoodRoleFromRequest(request *http.Request) (string, error) {
	_, port, err := net.SplitHostPort(request.Host)
	if err != nil || port != "443" {
		return "", fmt.Errorf("Due Good executor proxy permits CONNECT port 443 only")
	}
	return "duegood", nil
}

func main() {
	configuration, err := cmd.NewConfiguration(nil, nil)
	if err != nil {
		logrus.Fatalf("Could not create configuration: %v", err)
	}
	if configuration == nil {
		return
	}

	configuration.RoleFromRequest = dueGoodRoleFromRequest
	configuration.Log.Formatter = &logrus.JSONFormatter{}
	log.SetOutput(&smokescreen.Log2LogrusWriter{
		Entry: configuration.Log.WithField("stdlog", "1"),
	})
	log.SetFlags(0)
	smokescreen.StartWithConfig(configuration, nil)
}
